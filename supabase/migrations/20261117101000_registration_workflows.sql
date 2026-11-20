BEGIN;

ALTER TABLE public.college_students
  ADD COLUMN IF NOT EXISTS application_id uuid UNIQUE,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS home_address text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS photo_path text;

ALTER TABLE public.college_staff
  ADD COLUMN IF NOT EXISTS application_id uuid UNIQUE,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS photo_path text;

DROP POLICY IF EXISTS college_profiles_read ON public.college_profiles;
CREATE POLICY college_profiles_read
  ON public.college_profiles FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
  );

CREATE SEQUENCE IF NOT EXISTS public.college_student_number_seq;
CREATE SEQUENCE IF NOT EXISTS public.college_staff_number_seq;
REVOKE ALL ON SEQUENCE public.college_student_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.college_staff_number_seq FROM PUBLIC, anon, authenticated;

CREATE TABLE public.college_student_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text NOT NULL,
  date_of_birth date NOT NULL,
  gender text NOT NULL CHECK (gender IN ('female', 'male', 'other', 'prefer_not_to_say')),
  home_address text NOT NULL,
  emergency_contact_name text NOT NULL,
  emergency_contact_phone text NOT NULL,
  programme_id uuid NOT NULL REFERENCES public.college_programmes (id),
  photo_path text NOT NULL,
  application_status text NOT NULL DEFAULT 'pending'
    CHECK (application_status IN ('pending', 'approved', 'rejected')),
  reviewer_note text,
  reviewed_by uuid REFERENCES public.college_profiles (id),
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_student_application_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES public.college_student_applications (id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('identity', 'certificate', 'other')),
  storage_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_staff_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  staff_type text NOT NULL CHECK (staff_type IN ('lecturer', 'non_teaching_staff')),
  full_name text NOT NULL,
  phone text NOT NULL,
  department_id uuid NOT NULL REFERENCES public.college_departments (id),
  job_title text NOT NULL,
  highest_qualification text NOT NULL,
  years_experience smallint NOT NULL CHECK (years_experience BETWEEN 0 AND 60),
  photo_path text NOT NULL,
  application_status text NOT NULL DEFAULT 'pending'
    CHECK (application_status IN ('pending', 'approved', 'rejected')),
  reviewer_note text,
  reviewed_by uuid REFERENCES public.college_profiles (id),
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_staff_application_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES public.college_staff_applications (id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('cv', 'qualification', 'other')),
  storage_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.college_students
  ADD CONSTRAINT college_students_application_fk
  FOREIGN KEY (application_id) REFERENCES public.college_student_applications (id);

ALTER TABLE public.college_staff
  ADD CONSTRAINT college_staff_application_fk
  FOREIGN KEY (application_id) REFERENCES public.college_staff_applications (id);

CREATE INDEX college_student_applications_status_idx
  ON public.college_student_applications (application_status, submitted_at DESC);
CREATE INDEX college_student_applications_programme_idx
  ON public.college_student_applications (programme_id);
CREATE INDEX college_student_application_documents_application_idx
  ON public.college_student_application_documents (application_id);
CREATE INDEX college_staff_applications_status_idx
  ON public.college_staff_applications (application_status, submitted_at DESC);
CREATE INDEX college_staff_applications_department_idx
  ON public.college_staff_applications (department_id);
CREATE INDEX college_staff_application_documents_application_idx
  ON public.college_staff_application_documents (application_id);

CREATE TRIGGER college_student_applications_updated_at
  BEFORE UPDATE ON public.college_student_applications
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_staff_applications_updated_at
  BEFORE UPDATE ON public.college_staff_applications
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();

ALTER TABLE public.college_student_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_student_application_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_staff_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_staff_application_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY college_student_applications_read
  ON public.college_student_applications FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
  );
CREATE POLICY college_student_application_documents_read
  ON public.college_student_application_documents FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.college_student_applications AS application
      WHERE application.id = application_id
        AND (
          application.user_id = (SELECT auth.uid())
          OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
        )
    )
  );
CREATE POLICY college_staff_applications_read
  ON public.college_staff_applications FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
  );
CREATE POLICY college_staff_application_documents_read
  ON public.college_staff_application_documents FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.college_staff_applications AS application
      WHERE application.id = application_id
        AND (
          application.user_id = (SELECT auth.uid())
          OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
        )
    )
  );

CREATE OR REPLACE FUNCTION public.submit_college_student_application(
  p_full_name text,
  p_phone text,
  p_date_of_birth date,
  p_gender text,
  p_home_address text,
  p_emergency_contact_name text,
  p_emergency_contact_phone text,
  p_programme_id uuid,
  p_photo_path text,
  p_documents jsonb
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
    SELECT 1 FROM public.college_student_applications
    WHERE user_id = applicant_id
  ) OR EXISTS (
    SELECT 1 FROM public.college_staff_applications
    WHERE user_id = applicant_id
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

  IF NOT EXISTS (
    SELECT 1 FROM public.college_programmes
    WHERE id = p_programme_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active programme';
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

    SELECT
      object.metadata ->> 'mimetype',
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
    p_programme_id, p_photo_path
  )
  RETURNING id INTO application_id;

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

CREATE OR REPLACE FUNCTION public.submit_college_staff_application(
  p_staff_type text,
  p_full_name text,
  p_phone text,
  p_department_id uuid,
  p_job_title text,
  p_highest_qualification text,
  p_years_experience smallint,
  p_photo_path text,
  p_documents jsonb
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
  has_cv boolean := false;
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
    SELECT 1 FROM public.college_staff_applications
    WHERE user_id = applicant_id
  ) OR EXISTS (
    SELECT 1 FROM public.college_student_applications
    WHERE user_id = applicant_id
  ) THEN
    RAISE EXCEPTION 'An application has already been submitted for this account';
  END IF;

  IF p_staff_type NOT IN ('lecturer', 'non_teaching_staff')
     OR pg_catalog.length(pg_catalog.btrim(p_full_name)) < 3
     OR pg_catalog.length(pg_catalog.btrim(p_phone)) < 5
     OR pg_catalog.length(pg_catalog.btrim(p_job_title)) < 2
     OR pg_catalog.length(pg_catalog.btrim(p_highest_qualification)) < 2
     OR p_years_experience NOT BETWEEN 0 AND 60 THEN
    RAISE EXCEPTION 'Required staff details are invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.college_departments
    WHERE id = p_department_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  IF p_photo_path NOT LIKE
       'applications/' || applicant_id::text || '/staff/photo/%'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects
       WHERE bucket_id = 'college-applications'
         AND name = p_photo_path
         AND metadata ->> 'mimetype' IN ('image/jpeg', 'image/png', 'image/webp')
     ) THEN
    RAISE EXCEPTION 'Upload a valid staff photo before submitting';
  END IF;

  IF p_documents IS NULL
     OR pg_catalog.jsonb_typeof(p_documents) <> 'array'
     OR pg_catalog.jsonb_array_length(p_documents) < 1
     OR pg_catalog.jsonb_array_length(p_documents) > 8 THEN
    RAISE EXCEPTION 'Upload a CV and any supporting qualifications';
  END IF;

  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(p_documents)
  LOOP
    document_path := document ->> 'path';
    document_name := document ->> 'name';
    document_type := document ->> 'type';

    IF document_type NOT IN ('cv', 'qualification', 'other')
       OR document_name IS NULL
       OR pg_catalog.length(document_name) > 255
       OR document_path NOT LIKE
         'applications/' || applicant_id::text || '/staff/documents/%' THEN
      RAISE EXCEPTION 'A staff document entry is invalid';
    END IF;

    SELECT
      object.metadata ->> 'mimetype',
      NULLIF(object.metadata ->> 'size', '')::bigint
      INTO document_mime, document_size
      FROM storage.objects AS object
      WHERE object.bucket_id = 'college-applications'
        AND object.name = document_path;

    IF NOT FOUND
       OR document_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
       OR document_size NOT BETWEEN 1 AND 10485760 THEN
      RAISE EXCEPTION 'A staff document file is missing or has an invalid type or size';
    END IF;

    has_cv := has_cv OR document_type = 'cv';
  END LOOP;

  IF NOT has_cv THEN
    RAISE EXCEPTION 'A CV is required';
  END IF;

  INSERT INTO public.college_staff_applications (
    user_id, staff_type, full_name, phone, department_id, job_title,
    highest_qualification, years_experience, photo_path
  )
  VALUES (
    applicant_id, p_staff_type, pg_catalog.btrim(p_full_name), pg_catalog.btrim(p_phone),
    p_department_id, pg_catalog.btrim(p_job_title),
    pg_catalog.btrim(p_highest_qualification), p_years_experience, p_photo_path
  )
  RETURNING id INTO application_id;

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

    INSERT INTO public.college_staff_application_documents (
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

CREATE OR REPLACE FUNCTION public.approve_college_student_application(p_application_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  application public.college_student_applications%ROWTYPE;
  assigned_number text;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]) THEN
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

  assigned_number := 'STJ-' || pg_catalog.to_char(CURRENT_DATE, 'YYYY') || '-'
    || pg_catalog.lpad(pg_catalog.nextval('public.college_student_number_seq')::text, 6, '0');

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
    pg_catalog.jsonb_build_object('application_id', application.id, 'student_number', assigned_number)
  );

  RETURN assigned_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_college_staff_application(p_application_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  application public.college_staff_applications%ROWTYPE;
  assigned_number text;
  assigned_role public.stj_college_role;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'You are not allowed to approve staff applications'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application
    FROM public.college_staff_applications
    WHERE id = p_application_id
    FOR UPDATE;

  IF NOT FOUND OR application.application_status <> 'pending' THEN
    RAISE EXCEPTION 'The staff application is missing or is no longer pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.college_profiles
    WHERE id = application.user_id AND role = 'pending'
  ) THEN
    RAISE EXCEPTION 'The applicant account is not eligible for staff approval';
  END IF;

  assigned_number := 'STJ-S-' || pg_catalog.to_char(CURRENT_DATE, 'YYYY') || '-'
    || pg_catalog.lpad(pg_catalog.nextval('public.college_staff_number_seq')::text, 6, '0');
  assigned_role := CASE application.staff_type
    WHEN 'lecturer' THEN 'lecturer'::public.stj_college_role
    ELSE 'non_teaching_staff'::public.stj_college_role
  END;

  UPDATE public.college_profiles
    SET role = assigned_role
    WHERE id = application.user_id;

  INSERT INTO public.college_staff (
    id, application_id, staff_number, department_id, job_title,
    phone, photo_path, employment_status
  )
  VALUES (
    application.user_id, application.id, assigned_number, application.department_id,
    application.job_title, application.phone, application.photo_path, 'active'
  );

  UPDATE public.college_staff_applications
    SET application_status = 'approved',
        reviewed_by = actor_id,
        reviewed_at = pg_catalog.now()
    WHERE id = application.id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    application.user_id,
    'staff.application_approved',
    pg_catalog.jsonb_build_object(
      'application_id', application.id,
      'staff_number', assigned_number,
      'staff_type', application.staff_type
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_college_student_application(text, text, date, text, text, text, text, uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_college_staff_application(text, text, text, uuid, text, text, smallint, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_college_student_application(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_college_staff_application(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_college_student_application(text, text, date, text, text, text, text, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_college_staff_application(text, text, text, uuid, text, text, smallint, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_college_student_application(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_college_staff_application(uuid) TO authenticated;

REVOKE ALL ON TABLE
  public.college_student_applications,
  public.college_student_application_documents,
  public.college_staff_applications,
  public.college_staff_application_documents
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON
  public.college_student_applications,
  public.college_student_application_documents,
  public.college_staff_applications,
  public.college_staff_application_documents
TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'college-applications',
  'college-applications',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY college_application_files_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'college-applications'
    AND (
      (storage.foldername(name))[2] = (SELECT auth.uid())::text
      OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
    )
  );

CREATE POLICY college_application_files_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'college-applications'
    AND (storage.foldername(name))[1] = 'applications'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND (storage.foldername(name))[3] IN ('student', 'staff')
    AND (storage.foldername(name))[4] IN ('photo', 'documents')
    AND (
      (
        (storage.foldername(name))[4] = 'photo'
        AND metadata ->> 'mimetype' IN ('image/jpeg', 'image/png', 'image/webp')
      )
      OR (
        (storage.foldername(name))[4] = 'documents'
        AND metadata ->> 'mimetype' IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
      )
    )
  );

CREATE POLICY college_application_files_cleanup
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'college-applications'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.college_student_applications AS application
      WHERE application.user_id = (SELECT auth.uid())
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.college_staff_applications AS application
      WHERE application.user_id = (SELECT auth.uid())
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
