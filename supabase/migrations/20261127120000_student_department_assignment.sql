BEGIN;

CREATE OR REPLACE FUNCTION public.set_college_student_application_department_placement(
  p_application_id uuid,
  p_department_id uuid,
  p_programme_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_department_id uuid;
  selected_programme_department_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign student placement'
      USING ERRCODE = '42501';
  END IF;

  SELECT department.id
    INTO selected_department_id
    FROM public.college_departments AS department
    WHERE department.id = p_department_id
      AND department.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  SELECT programme.department_id
    INTO selected_programme_department_id
    FROM public.college_programmes AS programme
    WHERE programme.id = p_programme_id
      AND programme.is_active;
  IF NOT FOUND OR selected_programme_department_id <> selected_department_id THEN
    RAISE EXCEPTION 'Choose an active programme in the selected department';
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
        AND course.department_id <> selected_department_id
  ) THEN
    RAISE EXCEPTION 'The selected course offerings belong to a different department';
  END IF;

  PERFORM public.stj_validate_programme_study_year(p_programme_id, p_study_year);

  UPDATE public.college_student_applications
    SET department_id = selected_department_id,
        programme_id = p_programme_id,
        study_year = p_study_year
    WHERE id = p_application_id
      AND application_status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_application_department_placement(
  uuid, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_department_placement(
  uuid, uuid, uuid, integer
) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_college_student_department(
  p_student_id uuid,
  p_department_id uuid,
  p_programme_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_programme_department_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to transfer students'
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

  SELECT programme.department_id
    INTO selected_programme_department_id
    FROM public.college_programmes AS programme
    WHERE programme.id = p_programme_id
      AND programme.is_active;
  IF NOT FOUND OR selected_programme_department_id <> p_department_id THEN
    RAISE EXCEPTION 'Choose an active programme in the selected department';
  END IF;

  PERFORM public.transfer_college_student_programme(
    p_student_id,
    p_programme_id,
    p_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_college_student_department(uuid, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_college_student_department(uuid, uuid, uuid, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
