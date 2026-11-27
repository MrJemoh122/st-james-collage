BEGIN;

ALTER TABLE public.college_students
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.college_departments (id);

UPDATE public.college_students AS student
  SET department_id = programme.department_id
  FROM public.college_programmes AS programme
  WHERE programme.id = student.programme_id
    AND student.department_id IS NULL;

ALTER TABLE public.college_students
  ALTER COLUMN department_id SET NOT NULL,
  ALTER COLUMN programme_id DROP NOT NULL;

UPDATE public.college_student_applications AS application
  SET department_id = programme.department_id
  FROM public.college_programmes AS programme
  WHERE programme.id = application.programme_id
    AND application.department_id IS NULL;

DROP TRIGGER IF EXISTS college_students_set_study_year
  ON public.college_students;
DROP TRIGGER IF EXISTS college_students_sync_programme_year_enrollments
  ON public.college_students;
DROP TRIGGER IF EXISTS college_programme_year_offerings_sync_students
  ON public.college_programme_year_offerings;
DROP TRIGGER IF EXISTS college_programme_year_offerings_unmap_students
  ON public.college_programme_year_offerings;

DELETE FROM public.college_programme_year_offerings;
DELETE FROM public.college_programme_year_enrollment_sources;
DELETE FROM public.college_student_programme_history;

UPDATE public.college_students
  SET programme_id = NULL;
UPDATE public.college_student_applications
  SET programme_id = NULL;
DELETE FROM public.college_programmes;

DROP FUNCTION IF EXISTS public.set_college_student_application_placement(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.transfer_college_student_programme(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.set_college_student_application_department_placement(uuid, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.transfer_college_student_department(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.approve_college_student_application_with_courses(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.set_college_student_application_study_year(uuid, integer);
DROP FUNCTION IF EXISTS public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb
);
DROP FUNCTION IF EXISTS public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb, integer
);
DROP FUNCTION IF EXISTS public.stj_sync_students_after_programme_year_unmapping();
DROP FUNCTION IF EXISTS public.stj_sync_students_after_programme_year_mapping();
DROP FUNCTION IF EXISTS public.stj_sync_student_programme_year_after_change();
DROP FUNCTION IF EXISTS public.stj_sync_student_programme_year_enrollments(uuid);
DROP FUNCTION IF EXISTS public.stj_set_student_study_year_from_application();
DROP FUNCTION IF EXISTS public.stj_validate_programme_study_year(uuid, integer);

DROP POLICY IF EXISTS college_programmes_manage
  ON public.college_programmes;
DROP POLICY IF EXISTS college_programme_year_offerings_insert
  ON public.college_programme_year_offerings;
DROP POLICY IF EXISTS college_programme_year_offerings_delete
  ON public.college_programme_year_offerings;
REVOKE ALL ON TABLE
  public.college_programmes,
  public.college_programme_year_offerings,
  public.college_programme_year_enrollment_sources,
  public.college_student_programme_history
FROM authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_application_department_placement(
  p_application_id uuid,
  p_department_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign student placement'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.college_departments AS department
      WHERE department.id = p_department_id
        AND department.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;
  IF p_study_year IS NULL OR p_study_year < 1 OR p_study_year > 20 THEN
    RAISE EXCEPTION 'Choose a valid year of study';
  END IF;

  PERFORM 1
    FROM public.college_student_applications AS application
    WHERE application.id = p_application_id
      AND application.application_status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.college_student_application_course_choices AS choice
      JOIN public.college_course_offerings AS offering
        ON offering.id = choice.course_offering_id
      JOIN public.college_courses AS course
        ON course.id = offering.course_id
      WHERE choice.application_id = p_application_id
        AND course.department_id <> p_department_id
  ) THEN
    RAISE EXCEPTION 'The selected course offerings belong to a different department';
  END IF;

  UPDATE public.college_student_applications
    SET department_id = p_department_id,
        study_year = p_study_year
    WHERE id = p_application_id
      AND application_status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_application_department_placement(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_department_placement(uuid, uuid, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_college_student_application(
  p_application_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  application public.college_student_applications%ROWTYPE;
  assigned_number text;
  department_code text;
  admission_year smallint := pg_catalog.date_part('year', CURRENT_DATE)::smallint;
  sequence_number integer;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to approve student applications'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application
    FROM public.college_student_applications
    WHERE id = p_application_id
    FOR UPDATE;
  IF NOT FOUND OR application.application_status <> 'pending' THEN
    RAISE EXCEPTION 'The student application is missing or is no longer pending';
  END IF;
  IF application.study_year IS NULL OR application.study_year < 1 THEN
    RAISE EXCEPTION 'Assign a year of study before approving this student';
  END IF;

  SELECT pg_catalog.upper(department.code)
    INTO department_code
    FROM public.college_departments AS department
    WHERE department.id = application.department_id
      AND department.is_active
    FOR SHARE;
  IF department_code IS NULL OR department_code !~ '^[A-Z0-9]{2,12}$' THEN
    RAISE EXCEPTION 'The selected department must have an active code of 2 to 12 letters or numbers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.college_profiles
    WHERE id = application.user_id AND role = 'pending'
  ) THEN
    RAISE EXCEPTION 'The applicant account is not eligible for student approval';
  END IF;

  INSERT INTO public.college_student_number_sequences (
    course_code, admission_year, last_issued
  )
  VALUES (department_code, admission_year, 1)
  ON CONFLICT (course_code, admission_year)
  DO UPDATE SET last_issued = public.college_student_number_sequences.last_issued + 1
  WHERE public.college_student_number_sequences.last_issued < 9999
  RETURNING last_issued INTO sequence_number;
  IF sequence_number IS NULL THEN
    RAISE EXCEPTION 'The registration sequence for this department and year has reached its four-digit limit';
  END IF;

  assigned_number := 'STJIT/' || department_code || '/'
    || pg_catalog.lpad(sequence_number::text, 4, '0') || '/'
    || admission_year::text;

  UPDATE public.college_profiles
    SET role = 'student'
    WHERE id = application.user_id;

  INSERT INTO public.college_students (
    id, application_id, student_number, department_id, study_year, admitted_on,
    phone, date_of_birth, gender, home_address, emergency_contact_name,
    emergency_contact_phone, photo_path
  )
  VALUES (
    application.user_id, application.id, assigned_number, application.department_id,
    application.study_year, CURRENT_DATE, application.phone, application.date_of_birth,
    application.gender, application.home_address, application.emergency_contact_name,
    application.emergency_contact_phone, application.photo_path
  );

  UPDATE public.college_student_applications
    SET application_status = 'approved',
        reviewed_by = actor_id,
        reviewed_at = pg_catalog.now()
    WHERE id = application.id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    application.user_id,
    'student.application_approved',
    pg_catalog.jsonb_build_object(
      'application_id', application.id,
      'student_number', assigned_number,
      'department_id', application.department_id,
      'admission_year', admission_year
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_college_student_application(uuid)
  FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.approve_college_student_application_with_courses(uuid, uuid, integer);
CREATE FUNCTION public.approve_college_student_application_with_courses(
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
    WHERE choice.application_id = application.id
      AND offering.student_selection_open
      AND course.is_active
      AND course.department_id = p_department_id;

  IF choice_count = 0 OR choice_count <> available_choice_count THEN
    RAISE EXCEPTION 'Choose a department that matches all requested course offerings, and ensure they are still open';
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

CREATE OR REPLACE FUNCTION public.transfer_college_student_department(
  p_student_id uuid,
  p_department_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  previous_department_id uuid;
  student_number text;
  transfer_reason text := pg_catalog.btrim(p_reason);
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to change student departments'
      USING ERRCODE = '42501';
  END IF;
  IF transfer_reason IS NULL OR transfer_reason = '' OR pg_catalog.length(transfer_reason) > 500 THEN
    RAISE EXCEPTION 'A reason of 1 to 500 characters is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.college_departments
    WHERE id = p_department_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  SELECT student.department_id, student.student_number
    INTO previous_department_id, student_number
    FROM public.college_students AS student
    WHERE student.id = p_student_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student record does not exist';
  END IF;
  IF previous_department_id = p_department_id THEN
    RAISE EXCEPTION 'The student is already assigned to that department';
  END IF;

  UPDATE public.college_students
    SET department_id = p_department_id
    WHERE id = p_student_id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    p_student_id,
    'student.department_changed',
    pg_catalog.jsonb_build_object(
      'from_department_id', previous_department_id,
      'to_department_id', p_department_id,
      'student_number', student_number,
      'reason', transfer_reason
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_college_student_department(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_college_student_department(uuid, uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_study_year(
  p_student_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to update this student'
      USING ERRCODE = '42501';
  END IF;
  IF p_study_year IS NULL OR p_study_year < 1 OR p_study_year > 20 THEN
    RAISE EXCEPTION 'Choose a valid year of study';
  END IF;

  PERFORM 1
    FROM public.college_students AS student
    WHERE student.id = p_student_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student record does not exist';
  END IF;

  UPDATE public.college_students
    SET study_year = p_study_year
    WHERE id = p_student_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_study_year(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_study_year(uuid, integer)
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
  selected_course_department_id uuid;
  enrollment_id uuid;
BEGIN
  IF student_id IS NULL
     OR NOT public.stj_has_role(ARRAY['student']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'Only an active student can select a course offering'
      USING ERRCODE = '42501';
  END IF;

  SELECT student.department_id
    INTO student_department_id
    FROM public.college_students AS student
    WHERE student.id = student_id
      AND student.student_status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active student record and department are required';
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
    RAISE EXCEPTION 'Choose an offering from your department';
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
      'department_id', student_department_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.select_college_course_offering(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.select_college_course_offering(uuid)
  TO authenticated;

DROP INDEX IF EXISTS public.college_students_programme_idx;
DROP INDEX IF EXISTS public.college_student_applications_programme_idx;

NOTIFY pgrst, 'reload schema';

COMMIT;
