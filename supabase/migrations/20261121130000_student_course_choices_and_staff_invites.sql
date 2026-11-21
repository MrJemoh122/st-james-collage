BEGIN;

ALTER TABLE public.college_student_applications
  ALTER COLUMN programme_id DROP NOT NULL;

ALTER TABLE public.college_course_offerings
  ADD COLUMN student_selection_open boolean NOT NULL DEFAULT true;

CREATE TABLE public.college_student_application_course_choices (
  application_id uuid NOT NULL REFERENCES public.college_student_applications (id) ON DELETE CASCADE,
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, course_offering_id)
);

ALTER TABLE public.college_student_application_course_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.college_student_application_course_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.college_student_application_course_choices TO authenticated;

CREATE POLICY college_student_application_course_choices_read
  ON public.college_student_application_course_choices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.college_student_applications AS application
      WHERE application.id = application_id
        AND (
          application.user_id = (SELECT auth.uid())
          OR public.stj_has_role(
            ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.submit_college_student_application_with_courses(
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
  applicant_id uuid := auth.uid();
  application_id uuid;
  document jsonb;
  document_path text;
  document_name text;
  document_type text;
  document_mime text;
  document_size bigint;
  has_identity boolean := false;
  has_certificate boolean := false;
BEGIN
  IF applicant_id IS NULL THEN
    RAISE EXCEPTION 'A pending authenticated account is required to apply';
  END IF;

  PERFORM 1 FROM public.college_profiles
    WHERE id = applicant_id AND role = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A pending authenticated account is required to apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.college_student_applications WHERE user_id = applicant_id
  ) OR EXISTS (
    SELECT 1 FROM public.college_staff_applications WHERE user_id = applicant_id
  ) THEN
    RAISE EXCEPTION 'An application has already been submitted for this account';
  END IF;

  IF pg_catalog.length(pg_catalog.btrim(p_full_name)) < 3
     OR pg_catalog.length(pg_catalog.btrim(p_phone)) < 5
     OR pg_catalog.length(pg_catalog.btrim(p_home_address)) < 5
     OR pg_catalog.length(pg_catalog.btrim(p_emergency_contact_name)) < 2
     OR pg_catalog.length(pg_catalog.btrim(p_emergency_contact_phone)) < 5
     OR p_gender NOT IN ('female', 'male', 'other', 'prefer_not_to_say') THEN
    RAISE EXCEPTION 'Required student details are invalid';
  END IF;

  IF p_date_of_birth IS NULL OR p_date_of_birth >= CURRENT_DATE THEN
    RAISE EXCEPTION 'A valid date of birth is required';
  END IF;

  IF p_course_offering_ids IS NULL
     OR pg_catalog.cardinality(p_course_offering_ids) < 1
     OR pg_catalog.cardinality(p_course_offering_ids) <> (
       SELECT pg_catalog.count(DISTINCT selected.course_offering_id)
       FROM pg_catalog.unnest(p_course_offering_ids) AS selected(course_offering_id)
     ) THEN
    RAISE EXCEPTION 'Choose at least one different course offering';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_course_offering_ids) AS selected(id)
    LEFT JOIN public.college_course_offerings AS offering ON offering.id = selected.id
    LEFT JOIN public.college_courses AS course ON course.id = offering.course_id
    WHERE offering.id IS NULL
       OR NOT offering.student_selection_open
       OR NOT course.is_active
  ) THEN
    RAISE EXCEPTION 'One or more selected course offerings are no longer available';
  END IF;

  IF p_photo_path NOT LIKE
       'applications/' || applicant_id::text || '/student/photo/%'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects
       WHERE bucket_id = 'college-applications'
         AND name = p_photo_path
         AND metadata ->> 'mimetype' IN ('image/jpeg', 'image/png', 'image/webp')
     ) THEN
    RAISE EXCEPTION 'Upload a valid student photo before submitting';
  END IF;

  IF p_documents IS NULL
     OR pg_catalog.jsonb_typeof(p_documents) <> 'array'
     OR pg_catalog.jsonb_array_length(p_documents) < 2
     OR pg_catalog.jsonb_array_length(p_documents) > 8 THEN
    RAISE EXCEPTION 'Upload an identity document and an academic certificate';
  END IF;

  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(p_documents)
  LOOP
    document_path := document ->> 'path';
    document_name := document ->> 'name';
    document_type := document ->> 'type';

    IF document_type NOT IN ('identity', 'certificate', 'other')
       OR document_name IS NULL
       OR pg_catalog.length(document_name) > 255
       OR document_path NOT LIKE
         'applications/' || applicant_id::text || '/student/documents/%' THEN
      RAISE EXCEPTION 'A student document entry is invalid';
    END IF;

    SELECT object.metadata ->> 'mimetype',
           NULLIF(object.metadata ->> 'size', '')::bigint
      INTO document_mime, document_size
      FROM storage.objects AS object
      WHERE object.bucket_id = 'college-applications'
        AND object.name = document_path;

    IF NOT FOUND
       OR document_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
       OR document_size NOT BETWEEN 1 AND 10485760 THEN
      RAISE EXCEPTION 'A student document file is missing or has an invalid type or size';
    END IF;

    has_identity := has_identity OR document_type = 'identity';
    has_certificate := has_certificate OR document_type = 'certificate';
  END LOOP;

  IF NOT has_identity OR NOT has_certificate THEN
    RAISE EXCEPTION 'An identity document and an academic certificate are required';
  END IF;

  INSERT INTO public.college_student_applications (
    user_id, full_name, phone, date_of_birth, gender, home_address,
    emergency_contact_name, emergency_contact_phone, programme_id, photo_path
  )
  VALUES (
    applicant_id, pg_catalog.btrim(p_full_name), pg_catalog.btrim(p_phone),
    p_date_of_birth, p_gender, pg_catalog.btrim(p_home_address),
    pg_catalog.btrim(p_emergency_contact_name), pg_catalog.btrim(p_emergency_contact_phone),
    NULL, p_photo_path
  )
  RETURNING id INTO application_id;

  INSERT INTO public.college_student_application_course_choices (application_id, course_offering_id)
  SELECT application_id, selected.id
  FROM pg_catalog.unnest(p_course_offering_ids) AS selected(id);

  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(p_documents)
  LOOP
    document_path := document ->> 'path';
    document_name := document ->> 'name';
    document_type := document ->> 'type';

    SELECT object.metadata ->> 'mimetype',
           NULLIF(object.metadata ->> 'size', '')::bigint
      INTO document_mime, document_size
      FROM storage.objects AS object
      WHERE object.bucket_id = 'college-applications'
        AND object.name = document_path;

    INSERT INTO public.college_student_application_documents (
      application_id, document_type, storage_path, original_name, mime_type, byte_size
    )
    VALUES (
      application_id, document_type, document_path, document_name, document_mime, document_size
    );
  END LOOP;

  UPDATE public.college_profiles
    SET full_name = pg_catalog.btrim(p_full_name),
        phone = pg_catalog.btrim(p_phone)
    WHERE id = applicant_id;

  RETURN application_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_college_student_application_with_courses(
  text, text, date, text, text, text, text, text, jsonb, uuid[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_college_student_application_with_courses(
  text, text, date, text, text, text, text, text, jsonb, uuid[]
) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_college_staff_application(
  text, text, text, uuid, text, text, smallint, text, jsonb
) FROM PUBLIC, anon, authenticated;

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
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign student placement'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.stj_validate_programme_study_year(p_programme_id, p_study_year);

  UPDATE public.college_student_applications
    SET programme_id = p_programme_id,
        study_year = p_study_year
    WHERE id = p_application_id
      AND application_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_college_student_application_with_courses(
  p_application_id uuid,
  p_programme_id uuid,
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

  SELECT pg_catalog.count(*) INTO choice_count
  FROM public.college_student_application_course_choices AS choice
  WHERE choice.application_id = application.id;
  SELECT pg_catalog.count(*) INTO available_choice_count
  FROM public.college_student_application_course_choices AS choice
  JOIN public.college_course_offerings AS offering
    ON offering.id = choice.course_offering_id
  JOIN public.college_courses AS course ON course.id = offering.course_id
  WHERE choice.application_id = application.id
    AND offering.student_selection_open
    AND course.is_active;

  IF choice_count > 0 AND choice_count <> available_choice_count THEN
    RAISE EXCEPTION 'One or more requested course offerings are no longer available';
  END IF;

  PERFORM public.set_college_student_application_placement(
    p_application_id, p_programme_id, p_study_year
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

REVOKE ALL ON FUNCTION public.set_college_student_application_placement(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_placement(uuid, uuid, integer)
  TO authenticated;
REVOKE ALL ON FUNCTION public.approve_college_student_application(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_college_student_application_with_courses(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_college_student_application_with_courses(uuid, uuid, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.create_college_staff_account(
  p_actor_id uuid,
  p_user_id uuid,
  p_staff_type text,
  p_department_id uuid,
  p_job_title text,
  p_phone text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  assigned_number text;
  account_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.college_profiles
    WHERE id = p_actor_id
      AND role IN ('super_admin', 'college_admin', 'academic_registrar')
  ) THEN
    RAISE EXCEPTION 'You are not allowed to create staff accounts'
      USING ERRCODE = '42501';
  END IF;

  IF p_staff_type NOT IN ('lecturer', 'non_teaching_staff')
     OR pg_catalog.length(pg_catalog.btrim(p_job_title)) < 2
     OR pg_catalog.length(pg_catalog.btrim(p_phone)) < 5
     OR NOT EXISTS (
       SELECT 1 FROM public.college_departments
       WHERE id = p_department_id AND is_active
     ) THEN
    RAISE EXCEPTION 'Staff account details are invalid';
  END IF;

  SELECT NULLIF(auth_user.raw_user_meta_data ->> 'full_name', '')
    INTO account_name
    FROM auth.users AS auth_user
    WHERE auth_user.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The invited Auth account was not found';
  END IF;

  UPDATE public.college_profiles
    SET full_name = COALESCE(account_name, full_name),
        phone = pg_catalog.btrim(p_phone),
        role = p_staff_type::public.stj_college_role
    WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The invited account profile was not created';
  END IF;

  assigned_number := 'STJ-S-' || pg_catalog.to_char(CURRENT_DATE, 'YYYY') || '-'
    || pg_catalog.lpad(pg_catalog.nextval('public.college_staff_number_seq')::text, 6, '0');

  INSERT INTO public.college_staff (
    id, staff_number, department_id, job_title, phone, employment_status
  )
  VALUES (
    p_user_id, assigned_number, p_department_id, pg_catalog.btrim(p_job_title),
    pg_catalog.btrim(p_phone), 'active'
  );

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    p_actor_id,
    p_user_id,
    'staff.account_created',
    pg_catalog.jsonb_build_object(
      'staff_number', assigned_number,
      'staff_type', p_staff_type,
      'department_id', p_department_id
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.create_college_staff_account(uuid, uuid, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_college_staff_account(uuid, uuid, text, uuid, text, text)
  TO service_role;

COMMIT;
