BEGIN;

ALTER TABLE public.college_student_applications
  ADD COLUMN IF NOT EXISTS department_id uuid
  REFERENCES public.college_departments (id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.submit_college_student_application_with_department_and_courses(
  p_department_id uuid,
  p_full_name text,
  p_phone text,
  p_date_of_birth date,
  p_gender text,
  p_home_address text,
  p_emergency_contact_name text,
  p_emergency_contact_phone text,
  p_photo_path text,
  p_documents jsonb,
  p_course_offering_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_application_id uuid;
BEGIN
  IF p_department_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.college_departments AS department
      WHERE department.id = p_department_id AND department.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  IF p_course_offering_ids IS NULL OR EXISTS (
    SELECT 1
      FROM pg_catalog.unnest(p_course_offering_ids) AS selected(offering_id)
      LEFT JOIN public.college_course_offerings AS offering
        ON offering.id = selected.offering_id
      LEFT JOIN public.college_courses AS course
        ON course.id = offering.course_id
      WHERE offering.id IS NULL
         OR course.department_id IS DISTINCT FROM p_department_id
  ) THEN
    RAISE EXCEPTION 'Choose course offerings from your selected department only';
  END IF;

  new_application_id := public.submit_college_student_application_with_courses(
    p_full_name,
    p_phone,
    p_date_of_birth,
    p_gender,
    p_home_address,
    p_emergency_contact_name,
    p_emergency_contact_phone,
    p_photo_path,
    p_documents,
    p_course_offering_ids
  );

  UPDATE public.college_student_applications
    SET department_id = p_department_id
    WHERE id = new_application_id
      AND user_id = auth.uid()
      AND application_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student application department could not be saved';
  END IF;

  RETURN new_application_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_college_student_application_with_department_and_courses(
  uuid, text, text, date, text, text, text, text, text, jsonb, uuid[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_college_student_application_with_department_and_courses(
  uuid, text, text, date, text, text, text, text, text, jsonb, uuid[]
) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_application_placement(
  p_application_id uuid,
  p_programme_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  application_department_id uuid;
  programme_department_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign student placement'
      USING ERRCODE = '42501';
  END IF;

  SELECT application.department_id
    INTO application_department_id
    FROM public.college_student_applications AS application
    WHERE application.id = p_application_id
      AND application.application_status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;

  SELECT programme.department_id
    INTO programme_department_id
    FROM public.college_programmes AS programme
    WHERE programme.id = p_programme_id
      AND programme.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active programme';
  END IF;

  IF application_department_id IS NOT NULL
     AND application_department_id <> programme_department_id THEN
    RAISE EXCEPTION 'Assign a programme in the department selected by the student';
  END IF;

  PERFORM public.stj_validate_programme_study_year(p_programme_id, p_study_year);

  UPDATE public.college_student_applications
    SET programme_id = p_programme_id,
        study_year = p_study_year
    WHERE id = p_application_id
      AND application_status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_application_placement(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_placement(uuid, uuid, integer)
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
  student_programme_id uuid;
  student_department_id uuid;
  selected_course_department_id uuid;
  enrollment_id uuid;
BEGIN
  IF student_id IS NULL
     OR NOT public.stj_has_role(ARRAY['student']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'Only an active student can select a course offering'
      USING ERRCODE = '42501';
  END IF;

  SELECT student.programme_id, programme.department_id
    INTO student_programme_id, student_department_id
    FROM public.college_students AS student
    JOIN public.college_programmes AS programme
      ON programme.id = student.programme_id
    WHERE student.id = student_id
      AND student.student_status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active student record and programme are required';
  END IF;

  SELECT course.department_id
    INTO selected_course_department_id
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
    RAISE EXCEPTION 'Choose an offering from your programme department';
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
      'programme_id', student_programme_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.select_college_course_offering(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.select_college_course_offering(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_college_lecturer_course_roster(
  p_course_offering_id uuid
)
RETURNS TABLE(student_number text, full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(ARRAY['lecturer']::public.stj_college_role[])
     OR NOT EXISTS (
       SELECT 1
         FROM public.college_course_offerings AS offering
         WHERE offering.id = p_course_offering_id
           AND offering.lecturer_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'You are not assigned to this course offering'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT student.student_number, COALESCE(profile.full_name, '')
      FROM public.college_enrollments AS enrollment
      JOIN public.college_students AS student
        ON student.id = enrollment.student_id
      JOIN public.college_profiles AS profile
        ON profile.id = student.id
      WHERE enrollment.course_offering_id = p_course_offering_id
        AND enrollment.enrollment_status = 'enrolled'
      ORDER BY profile.full_name, student.student_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_college_lecturer_course_roster(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_college_lecturer_course_roster(uuid)
  TO authenticated;

COMMIT;
