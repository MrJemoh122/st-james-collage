BEGIN;

CREATE TABLE IF NOT EXISTS public.college_course_study_years (
  course_id uuid NOT NULL REFERENCES public.college_courses (id) ON DELETE CASCADE,
  study_year smallint NOT NULL CHECK (study_year BETWEEN 1 AND 20),
  PRIMARY KEY (course_id, study_year)
);

INSERT INTO public.college_course_study_years (course_id, study_year)
SELECT course.id, years.study_year::smallint
FROM public.college_courses AS course
CROSS JOIN generate_series(1, 20) AS years(study_year)
ON CONFLICT DO NOTHING;

ALTER TABLE public.college_course_study_years ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.college_course_study_years
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.college_course_study_years
  TO authenticated;

CREATE POLICY college_course_study_years_read
  ON public.college_course_study_years FOR SELECT TO authenticated
  USING (true);

CREATE POLICY college_course_study_years_manage
  ON public.college_course_study_years FOR ALL TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_courses AS course
        WHERE course.id = college_course_study_years.course_id
          AND course.department_id = public.stj_staff_department_id(auth.uid())
      )
    )
  )
  WITH CHECK (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_courses AS course
        WHERE course.id = college_course_study_years.course_id
          AND course.department_id = public.stj_staff_department_id(auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS college_courses_read ON public.college_courses;
CREATE POLICY college_courses_read
  ON public.college_courses FOR SELECT TO authenticated
  USING (
    NOT public.stj_has_role(
      ARRAY['student', 'pending']::public.stj_college_role[]
    )
    OR (
      public.stj_has_role(ARRAY['pending']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_course_study_years AS course_year
        WHERE course_year.course_id = college_courses.id
      )
    )
    OR (
      public.stj_has_role(ARRAY['student']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_students AS student
        JOIN public.college_course_study_years AS course_year
          ON course_year.study_year = student.study_year
        WHERE student.id = auth.uid()
          AND student.department_id = college_courses.department_id
          AND course_year.course_id = college_courses.id
      )
    )
  );

CREATE OR REPLACE FUNCTION public.approve_college_student_application_with_courses(
  p_application_id uuid,
  p_department_id uuid,
  p_study_year integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  application public.college_student_applications%ROWTYPE;
  assigned_number text;
  choice_count bigint;
  available_choice_count bigint;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to approve student applications'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application
    FROM public.college_student_applications
    WHERE id = p_application_id
      AND application_status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;

  SELECT pg_catalog.count(*)
    INTO choice_count
    FROM public.college_student_application_course_choices AS choice
    WHERE choice.application_id = application.id;
  SELECT pg_catalog.count(*)
    INTO available_choice_count
    FROM public.college_student_application_course_choices AS choice
    JOIN public.college_course_offerings AS offering
      ON offering.id = choice.course_offering_id
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    JOIN public.college_course_study_years AS course_year
      ON course_year.course_id = course.id
     AND course_year.study_year = p_study_year
    WHERE choice.application_id = application.id
      AND offering.student_selection_open
      AND course.is_active
      AND course.department_id = p_department_id;

  IF choice_count = 0 OR choice_count <> available_choice_count THEN
    RAISE EXCEPTION 'Choose a department and study year that match all requested course offerings, and ensure they are still open';
  END IF;

  PERFORM public.set_college_student_application_department_placement(
    p_application_id, p_department_id, p_study_year
  );
  assigned_number := public.approve_college_student_application(p_application_id);

  INSERT INTO public.college_enrollments (student_id, course_offering_id, enrollment_status)
  SELECT application.user_id, choice.course_offering_id, 'enrolled'
    FROM public.college_student_application_course_choices AS choice
    WHERE choice.application_id = application.id
  ON CONFLICT (student_id, course_offering_id)
  DO UPDATE SET enrollment_status = 'enrolled';

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_college_student_application_with_courses(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_college_student_application_with_courses(uuid, uuid, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.select_college_course_offering(
  p_course_offering_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_id uuid := auth.uid();
  student_department_id uuid;
  student_study_year smallint;
  selected_course_id uuid;
  selected_course_department_id uuid;
  enrollment_id uuid;
BEGIN
  IF student_id IS NULL
     OR NOT public.stj_has_role(ARRAY['student']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'Only an active student can select a course offering'
      USING ERRCODE = '42501';
  END IF;

  SELECT student.department_id, student.study_year
    INTO student_department_id, student_study_year
    FROM public.college_students AS student
    WHERE student.id = student_id
      AND student.student_status = 'active';
  IF NOT FOUND OR student_study_year IS NULL THEN
    RAISE EXCEPTION 'An active student record, department, and study year are required';
  END IF;

  SELECT course.id, course.department_id
    INTO selected_course_id, selected_course_department_id
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE offering.id = p_course_offering_id
      AND offering.student_selection_open
      AND course.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This course offering is not open for student selection';
  END IF;
  IF selected_course_department_id <> student_department_id THEN
    RAISE EXCEPTION 'Choose an offering from your department';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.college_course_study_years AS course_year
    WHERE course_year.course_id = selected_course_id
      AND course_year.study_year = student_study_year
  ) THEN
    RAISE EXCEPTION 'This subject is not assigned to your year of study';
  END IF;

  INSERT INTO public.college_enrollments (
    student_id, course_offering_id, enrollment_status
  )
  VALUES (student_id, p_course_offering_id, 'enrolled')
  ON CONFLICT (student_id, course_offering_id)
  DO UPDATE SET enrollment_status = 'enrolled'
    WHERE public.college_enrollments.enrollment_status = 'dropped'
  RETURNING id INTO enrollment_id;

  IF enrollment_id IS NULL THEN
    RAISE EXCEPTION 'You are already enrolled in or have completed this course offering';
  END IF;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    student_id,
    student_id,
    'student.course_selected',
    pg_catalog.jsonb_build_object(
      'course_offering_id', p_course_offering_id,
      'department_id', student_department_id,
      'study_year', student_study_year
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.select_college_course_offering(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.select_college_course_offering(uuid)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
