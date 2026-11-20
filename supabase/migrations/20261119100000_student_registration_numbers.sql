BEGIN;

ALTER TABLE public.college_programmes
  ADD COLUMN IF NOT EXISTS qualification_level text NOT NULL DEFAULT 'Other';

ALTER TABLE public.college_programmes
  ADD CONSTRAINT college_programmes_qualification_level_check
  CHECK (pg_catalog.length(pg_catalog.btrim(qualification_level)) > 0);

ALTER TABLE public.college_programmes
  ADD CONSTRAINT college_programmes_official_code_format_check
  CHECK (code ~ '^[A-Za-z0-9]{2,12}$');

CREATE UNIQUE INDEX IF NOT EXISTS college_programmes_official_code_key
  ON public.college_programmes (pg_catalog.upper(code));

CREATE TABLE public.college_student_number_sequences (
  course_code text NOT NULL CHECK (course_code ~ '^[A-Z0-9]{2,12}$'),
  admission_year smallint NOT NULL CHECK (admission_year BETWEEN 2000 AND 9999),
  last_issued integer NOT NULL CHECK (last_issued BETWEEN 1 AND 9999),
  PRIMARY KEY (course_code, admission_year)
);

WITH parsed_numbers AS (
  SELECT pg_catalog.regexp_match(
    student.student_number,
    '^STJIT/([A-Z0-9]{2,12})/([0-9]{4})/([0-9]{4})$'
  ) AS parts
  FROM public.college_students AS student
), valid_numbers AS (
  SELECT
    parts[1] AS course_code,
    parts[3]::smallint AS admission_year,
    parts[2]::integer AS student_number
  FROM parsed_numbers
  WHERE parts IS NOT NULL
)
INSERT INTO public.college_student_number_sequences (
  course_code, admission_year, last_issued
)
SELECT course_code, admission_year, pg_catalog.max(student_number)
FROM valid_numbers
WHERE student_number BETWEEN 1 AND 9999
  AND admission_year BETWEEN 2000 AND 9999
GROUP BY course_code, admission_year
ON CONFLICT (course_code, admission_year)
DO UPDATE SET last_issued = CASE
  WHEN public.college_student_number_sequences.last_issued > EXCLUDED.last_issued
    THEN public.college_student_number_sequences.last_issued
  ELSE EXCLUDED.last_issued
END;

CREATE TABLE public.college_student_programme_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.college_students (id) ON DELETE RESTRICT,
  programme_id uuid NOT NULL REFERENCES public.college_programmes (id) ON DELETE RESTRICT,
  programme_code text NOT NULL,
  qualification_level text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  changed_by uuid REFERENCES public.college_profiles (id),
  reason text NOT NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX college_student_programme_history_current_key
  ON public.college_student_programme_history (student_id)
  WHERE valid_to IS NULL;

INSERT INTO public.college_student_programme_history (
  student_id, programme_id, programme_code, qualification_level,
  valid_from, reason
)
SELECT
  student.id,
  programme.id,
  pg_catalog.upper(programme.code),
  programme.qualification_level,
  COALESCE(student.admitted_on::timestamptz, student.created_at),
  'Initial programme at migration'
FROM public.college_students AS student
JOIN public.college_programmes AS programme ON programme.id = student.programme_id
ON CONFLICT DO NOTHING;

ALTER TABLE public.college_student_programme_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY college_student_programme_history_read
  ON public.college_student_programme_history FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
  );

REVOKE ALL ON TABLE
  public.college_student_number_sequences,
  public.college_student_programme_history
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.college_student_programme_history TO authenticated;

CREATE OR REPLACE FUNCTION public.stj_prevent_student_number_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.student_number IS DISTINCT FROM OLD.student_number THEN
    RAISE EXCEPTION 'A student registration number cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER college_students_student_number_immutable
  BEFORE UPDATE OF student_number ON public.college_students
  FOR EACH ROW EXECUTE FUNCTION public.stj_prevent_student_number_change();

REVOKE UPDATE ON public.college_students FROM authenticated;
GRANT UPDATE (
  admitted_on, student_status, phone, date_of_birth, gender, home_address,
  emergency_contact_name, emergency_contact_phone, photo_path
) ON public.college_students TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_college_student_application(p_application_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  application public.college_student_applications%ROWTYPE;
  course_code text;
  admission_year smallint := pg_catalog.date_part('year', CURRENT_DATE)::smallint;
  sequence_number integer;
  assigned_number text;
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

  IF NOT EXISTS (
    SELECT 1 FROM public.college_profiles
    WHERE id = application.user_id AND role = 'pending'
  ) THEN
    RAISE EXCEPTION 'The applicant account is not eligible for student approval';
  END IF;

  SELECT pg_catalog.upper(programme.code) INTO course_code
  FROM public.college_programmes AS programme
  WHERE programme.id = application.programme_id AND programme.is_active
  FOR SHARE;

  IF course_code IS NULL OR course_code !~ '^[A-Z0-9]{2,12}$' THEN
    RAISE EXCEPTION 'The selected active programme has no valid official course code';
  END IF;

  INSERT INTO public.college_student_number_sequences (
    course_code, admission_year, last_issued
  )
  VALUES (course_code, admission_year, 1)
  ON CONFLICT (course_code, admission_year)
  DO UPDATE SET last_issued = public.college_student_number_sequences.last_issued + 1
  WHERE public.college_student_number_sequences.last_issued < 9999
  RETURNING last_issued INTO sequence_number;

  IF sequence_number IS NULL THEN
    RAISE EXCEPTION 'The registration sequence for this course and year has reached its four-digit limit';
  END IF;

  assigned_number := 'STJIT/' || course_code || '/'
    || pg_catalog.lpad(sequence_number::text, 4, '0') || '/'
    || admission_year::text;

  UPDATE public.college_profiles
  SET role = 'student'
  WHERE id = application.user_id;

  INSERT INTO public.college_students (
    id, application_id, student_number, programme_id, admitted_on, phone,
    date_of_birth, gender, home_address, emergency_contact_name,
    emergency_contact_phone, photo_path
  )
  VALUES (
    application.user_id, application.id, assigned_number, application.programme_id,
    CURRENT_DATE, application.phone, application.date_of_birth, application.gender,
    application.home_address, application.emergency_contact_name,
    application.emergency_contact_phone, application.photo_path
  );

  INSERT INTO public.college_student_programme_history (
    student_id, programme_id, programme_code, qualification_level,
    valid_from, changed_by, reason
  )
  SELECT
    application.user_id, programme.id, course_code, programme.qualification_level,
    pg_catalog.now(), actor_id, 'Initial admission'
  FROM public.college_programmes AS programme
  WHERE programme.id = application.programme_id;

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
      'programme_id', application.programme_id,
      'admission_year', admission_year
    )
  );

  RETURN assigned_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_college_student_programme(
  p_student_id uuid,
  p_programme_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  student public.college_students%ROWTYPE;
  course_code text;
  qualification text;
  transfer_time timestamptz := pg_catalog.clock_timestamp();
  transfer_reason text := pg_catalog.btrim(p_reason);
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to transfer students'
      USING ERRCODE = '42501';
  END IF;

  IF transfer_reason IS NULL OR transfer_reason = '' OR pg_catalog.length(transfer_reason) > 500 THEN
    RAISE EXCEPTION 'A transfer reason of 1 to 500 characters is required';
  END IF;

  SELECT * INTO student
  FROM public.college_students
  WHERE id = p_student_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student record does not exist';
  END IF;
  IF student.programme_id = p_programme_id THEN
    RAISE EXCEPTION 'The student is already enrolled in that programme';
  END IF;

  SELECT pg_catalog.upper(programme.code), programme.qualification_level
  INTO course_code, qualification
  FROM public.college_programmes AS programme
  WHERE programme.id = p_programme_id AND programme.is_active
  FOR SHARE;

  IF course_code IS NULL THEN
    RAISE EXCEPTION 'Choose an active programme';
  END IF;

  UPDATE public.college_student_programme_history
  SET valid_to = transfer_time
  WHERE student_id = student.id AND valid_to IS NULL;

  INSERT INTO public.college_student_programme_history (
    student_id, programme_id, programme_code, qualification_level,
    valid_from, changed_by, reason
  )
  VALUES (
    student.id, p_programme_id, course_code, qualification,
    transfer_time, actor_id, transfer_reason
  );

  UPDATE public.college_students
  SET programme_id = p_programme_id
  WHERE id = student.id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    student.id,
    'student.programme_transferred',
    pg_catalog.jsonb_build_object(
      'from_programme_id', student.programme_id,
      'to_programme_id', p_programme_id,
      'student_number', student.student_number,
      'reason', transfer_reason
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_college_student_application(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_college_student_programme(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_college_student_application(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_college_student_programme(uuid, uuid, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
