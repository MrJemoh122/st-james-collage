BEGIN;

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
  registration_year smallint := pg_catalog.date_part('year', CURRENT_DATE)::smallint;
  sequence_number integer;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to approve student applications'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO application
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
    SELECT 1
    FROM public.college_profiles
    WHERE id = application.user_id
      AND role = 'pending'
  ) THEN
    RAISE EXCEPTION 'The applicant account is not eligible for student approval';
  END IF;

  INSERT INTO public.college_student_number_sequences (
    course_code, admission_year, last_issued
  )
  VALUES (department_code, registration_year, 1)
  ON CONFLICT (course_code, admission_year)
  DO UPDATE SET last_issued = public.college_student_number_sequences.last_issued + 1
  WHERE public.college_student_number_sequences.last_issued < 9999
  RETURNING last_issued INTO sequence_number;
  IF sequence_number IS NULL THEN
    RAISE EXCEPTION 'The registration sequence for this department and year has reached its four-digit limit';
  END IF;

  assigned_number := 'STJIT/' || department_code || '/'
    || pg_catalog.lpad(sequence_number::text, 4, '0') || '/'
    || registration_year::text;

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
      'admission_year', registration_year
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_college_student_application(uuid)
  FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
