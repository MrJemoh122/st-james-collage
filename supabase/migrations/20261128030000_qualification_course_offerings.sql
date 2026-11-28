BEGIN;

CREATE TABLE public.college_qualification_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.college_departments (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 3 AND 160),
  is_active boolean NOT NULL DEFAULT true,
  application_open boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX college_qualification_offerings_department_name_key
  ON public.college_qualification_offerings (department_id, pg_catalog.lower(pg_catalog.btrim(name)));

CREATE TABLE public.college_qualification_subjects (
  qualification_offering_id uuid NOT NULL
    REFERENCES public.college_qualification_offerings (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.college_courses (id) ON DELETE RESTRICT,
  study_year smallint NOT NULL CHECK (study_year BETWEEN 1 AND 20),
  term smallint NOT NULL CHECK (term > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (qualification_offering_id, course_id, study_year, term)
);

CREATE INDEX college_qualification_subjects_course_term_idx
  ON public.college_qualification_subjects (course_id, term, study_year);

CREATE TABLE public.college_student_application_qualification_choices (
  application_id uuid NOT NULL
    REFERENCES public.college_student_applications (id) ON DELETE CASCADE,
  qualification_offering_id uuid NOT NULL
    REFERENCES public.college_qualification_offerings (id) ON DELETE RESTRICT,
  preference_order integer NOT NULL CHECK (preference_order > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, qualification_offering_id),
  UNIQUE (application_id, preference_order)
);

ALTER TABLE public.college_student_applications
  ADD COLUMN selected_qualification_offering_id uuid
    REFERENCES public.college_qualification_offerings (id) ON DELETE SET NULL;

ALTER TABLE public.college_students
  ADD COLUMN qualification_offering_id uuid
    REFERENCES public.college_qualification_offerings (id) ON DELETE SET NULL;

CREATE INDEX college_students_qualification_offering_idx
  ON public.college_students (qualification_offering_id);

ALTER TABLE public.college_qualification_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_qualification_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_student_application_qualification_choices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.college_qualification_offerings,
  public.college_qualification_subjects,
  public.college_student_application_qualification_choices
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.college_qualification_offerings TO authenticated;
GRANT SELECT
  ON TABLE public.college_qualification_subjects,
  public.college_student_application_qualification_choices
TO authenticated;

CREATE POLICY college_qualification_offerings_read
  ON public.college_qualification_offerings FOR SELECT TO authenticated
  USING (
    NOT public.stj_has_role(ARRAY['pending']::public.stj_college_role[])
    OR (
      is_active
      AND application_open
      AND EXISTS (
        SELECT 1
        FROM public.college_qualification_subjects AS subject
        WHERE subject.qualification_offering_id = id
      )
    )
  );

CREATE POLICY college_qualification_offerings_manage
  ON public.college_qualification_offerings FOR ALL TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND department_id = public.stj_staff_department_id((SELECT auth.uid()))
    )
  )
  WITH CHECK (
    (
      public.stj_has_role(
        ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
      )
      OR (
        public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
        AND department_id = public.stj_staff_department_id((SELECT auth.uid()))
      )
    )
    AND (
      NOT application_open
      OR EXISTS (
        SELECT 1
        FROM public.college_qualification_subjects AS subject
        WHERE subject.qualification_offering_id = id
      )
    )
  );

CREATE POLICY college_qualification_subjects_read
  ON public.college_qualification_subjects FOR SELECT TO authenticated
  USING (true);

CREATE POLICY college_student_application_qualification_choices_read
  ON public.college_student_application_qualification_choices FOR SELECT TO authenticated
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

CREATE OR REPLACE FUNCTION public.set_college_qualification_subject(
  p_qualification_offering_id uuid,
  p_course_id uuid,
  p_study_year smallint,
  p_term smallint,
  p_is_assigned boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  qualification_department_id uuid;
  subject_department_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (
       public.stj_has_role(
         ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
       )
       OR public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign subjects to course offerings'
      USING ERRCODE = '42501';
  END IF;

  IF p_study_year IS NULL OR p_study_year NOT BETWEEN 1 AND 20
     OR p_term IS NULL OR p_term < 1
     OR p_is_assigned IS NULL THEN
    RAISE EXCEPTION 'Choose a valid study year, term, and assignment action'
      USING ERRCODE = '22023';
  END IF;

  SELECT qualification.department_id
    INTO qualification_department_id
    FROM public.college_qualification_offerings AS qualification
    WHERE qualification.id = p_qualification_offering_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected course offering does not exist';
  END IF;

  SELECT course.department_id
    INTO subject_department_id
    FROM public.college_courses AS course
    WHERE course.id = p_course_id
      AND (NOT p_is_assigned OR course.is_active);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected subject does not exist or is inactive';
  END IF;

  IF subject_department_id IS DISTINCT FROM qualification_department_id THEN
    RAISE EXCEPTION 'Subjects must belong to the same department as the course offering';
  END IF;

  IF NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     )
     AND qualification_department_id IS DISTINCT FROM public.stj_staff_department_id(auth.uid()) THEN
    RAISE EXCEPTION 'You can only manage course offerings in your department'
      USING ERRCODE = '42501';
  END IF;

  IF p_is_assigned THEN
    INSERT INTO public.college_qualification_subjects (
      qualification_offering_id, course_id, study_year, term
    )
    VALUES (p_qualification_offering_id, p_course_id, p_study_year, p_term)
    ON CONFLICT DO NOTHING;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.college_qualification_offerings AS qualification
      WHERE qualification.id = p_qualification_offering_id
        AND qualification.application_open
    ) AND (
      SELECT pg_catalog.count(*)
      FROM public.college_qualification_subjects AS subject
      WHERE subject.qualification_offering_id = p_qualification_offering_id
    ) = 1 THEN
      RAISE EXCEPTION 'Close applications for this course offering before removing its final assigned subject';
    END IF;

    DELETE FROM public.college_qualification_subjects
      WHERE qualification_offering_id = p_qualification_offering_id
        AND course_id = p_course_id
        AND study_year = p_study_year
        AND term = p_term;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_qualification_subject(uuid, uuid, smallint, smallint, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_qualification_subject(uuid, uuid, smallint, smallint, boolean)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_college_student_application_with_qualification_preferences(
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
  p_qualification_offering_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  applicant_id uuid := auth.uid();
  application_id uuid;
  selected jsonb;
  document_path text;
  document_name text;
  document_type text;
  document_mime text;
  document_size bigint;
  has_identity boolean := false;
  has_certificate boolean := false;
BEGIN
  IF applicant_id IS NULL THEN
    RAISE EXCEPTION 'A pending authenticated account is required to apply'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.college_profiles
    WHERE id = applicant_id
      AND role = 'pending'
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

  IF p_department_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.college_departments AS department
    WHERE department.id = p_department_id
      AND department.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  IF p_full_name IS NULL
     OR p_phone IS NULL
     OR p_home_address IS NULL
     OR p_emergency_contact_name IS NULL
     OR p_emergency_contact_phone IS NULL
     OR p_gender IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_full_name)) < 3
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

  IF p_qualification_offering_ids IS NULL
     OR pg_catalog.cardinality(p_qualification_offering_ids) < 1
     OR pg_catalog.cardinality(p_qualification_offering_ids) <> (
       SELECT pg_catalog.count(DISTINCT choice.qualification_offering_id)
       FROM pg_catalog.unnest(p_qualification_offering_ids)
         AS choice(qualification_offering_id)
     ) THEN
    RAISE EXCEPTION 'Choose at least one different course offering';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_qualification_offering_ids)
      AS selected(qualification_offering_id)
    LEFT JOIN public.college_qualification_offerings AS qualification
      ON qualification.id = selected.qualification_offering_id
    WHERE qualification.id IS NULL
       OR qualification.department_id IS DISTINCT FROM p_department_id
       OR NOT qualification.is_active
       OR NOT qualification.application_open
       OR NOT EXISTS (
         SELECT 1
         FROM public.college_qualification_subjects AS subject
         WHERE subject.qualification_offering_id = qualification.id
       )
  ) THEN
    RAISE EXCEPTION 'Choose active, open course offerings with assigned subjects from your selected department';
  END IF;

  IF p_photo_path NOT LIKE
       'applications/' || applicant_id::text || '/student/photo/%'
     OR NOT EXISTS (
       SELECT 1
       FROM storage.objects
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

  FOR selected IN
    SELECT value FROM pg_catalog.jsonb_array_elements(p_documents)
  LOOP
    document_path := selected ->> 'path';
    document_name := selected ->> 'name';
    document_type := selected ->> 'type';

    IF document_type IS NULL
       OR document_type NOT IN ('identity', 'certificate', 'other')
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
       OR document_mime IS NULL
       OR document_size IS NULL
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
    user_id,
    full_name,
    phone,
    date_of_birth,
    gender,
    home_address,
    emergency_contact_name,
    emergency_contact_phone,
    programme_id,
    department_id,
    photo_path
  )
  VALUES (
    applicant_id,
    pg_catalog.btrim(p_full_name),
    pg_catalog.btrim(p_phone),
    p_date_of_birth,
    p_gender,
    pg_catalog.btrim(p_home_address),
    pg_catalog.btrim(p_emergency_contact_name),
    pg_catalog.btrim(p_emergency_contact_phone),
    NULL,
    p_department_id,
    p_photo_path
  )
  RETURNING id INTO application_id;

  INSERT INTO public.college_student_application_qualification_choices (
    application_id, qualification_offering_id, preference_order
  )
  SELECT application_id, choice.qualification_offering_id, choice.preference_order::integer
  FROM pg_catalog.unnest(p_qualification_offering_ids) WITH ORDINALITY
    AS choice(qualification_offering_id, preference_order);

  FOR selected IN
    SELECT value FROM pg_catalog.jsonb_array_elements(p_documents)
  LOOP
    document_path := selected ->> 'path';
    document_name := selected ->> 'name';
    document_type := selected ->> 'type';

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

REVOKE ALL ON FUNCTION public.submit_college_student_application_with_qualification_preferences(
  uuid, text, text, date, text, text, text, text, text, jsonb, uuid[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_college_student_application_with_qualification_preferences(
  uuid, text, text, date, text, text, text, text, text, jsonb, uuid[]
) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_application_qualification_placement(
  p_application_id uuid,
  p_department_id uuid,
  p_study_year integer,
  p_qualification_offering_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  application public.college_student_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to place student applications'
      USING ERRCODE = '42501';
  END IF;

  IF p_department_id IS NULL OR p_study_year IS NULL
     OR p_study_year NOT BETWEEN 1 AND 20
     OR p_qualification_offering_id IS NULL THEN
    RAISE EXCEPTION 'Choose a department, course offering, and valid year of study'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO application
    FROM public.college_student_applications
    WHERE id = p_application_id
      AND application_status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;

  IF application.department_id IS DISTINCT FROM p_department_id THEN
    RAISE EXCEPTION 'The applicant department cannot be changed during course-offering placement';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_departments AS department
    WHERE department.id = p_department_id
      AND department.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active department';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_qualification_offerings AS qualification
    JOIN public.college_student_application_qualification_choices AS choice
      ON choice.qualification_offering_id = qualification.id
    WHERE choice.application_id = application.id
      AND qualification.id = p_qualification_offering_id
      AND qualification.department_id = p_department_id
      AND qualification.is_active
  ) THEN
    RAISE EXCEPTION 'Choose one of the applicant''s active course-offering preferences';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_qualification_subjects AS subject
    WHERE subject.qualification_offering_id = p_qualification_offering_id
      AND subject.study_year = p_study_year
  ) THEN
    RAISE EXCEPTION 'The selected course offering has no subjects assigned for this year of study';
  END IF;

  UPDATE public.college_student_applications
    SET study_year = p_study_year,
        selected_qualification_offering_id = p_qualification_offering_id
    WHERE id = application.id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_application_qualification_placement(uuid, uuid, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_qualification_placement(uuid, uuid, integer, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.stj_validate_student_qualification_department()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    NEW.qualification_offering_id := NULL;
  END IF;

  IF NEW.qualification_offering_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.college_qualification_offerings AS qualification
       WHERE qualification.id = NEW.qualification_offering_id
         AND qualification.department_id = NEW.department_id
     ) THEN
    RAISE EXCEPTION 'The student''s course offering must belong to their department';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER college_students_validate_qualification_department
  BEFORE INSERT OR UPDATE OF department_id, qualification_offering_id
  ON public.college_students
  FOR EACH ROW EXECUTE FUNCTION public.stj_validate_student_qualification_department();

REVOKE ALL ON FUNCTION public.stj_validate_student_qualification_department()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_qualification(
  p_student_id uuid,
  p_qualification_offering_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student public.college_students%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to assign student course offerings'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO student
    FROM public.college_students
    WHERE id = p_student_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student record was not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_qualification_offerings AS qualification
    WHERE qualification.id = p_qualification_offering_id
      AND qualification.department_id = student.department_id
      AND qualification.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active course offering from the student''s department';
  END IF;

  UPDATE public.college_students
    SET qualification_offering_id = p_qualification_offering_id
    WHERE id = student.id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    auth.uid(),
    student.id,
    'student.qualification_assigned',
    pg_catalog.jsonb_build_object(
      'qualification_offering_id', p_qualification_offering_id,
      'department_id', student.department_id,
      'study_year', student.study_year
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_qualification(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_qualification(uuid, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_college_student_application_with_qualification(
  p_application_id uuid,
  p_department_id uuid,
  p_study_year integer,
  p_qualification_offering_id uuid
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
      AND application_status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pending student application was not found';
  END IF;

  PERFORM public.set_college_student_application_qualification_placement(
    p_application_id,
    p_department_id,
    p_study_year,
    p_qualification_offering_id
  );

  assigned_number := public.approve_college_student_application(p_application_id);

  UPDATE public.college_students
    SET qualification_offering_id = p_qualification_offering_id
    WHERE id = application.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student course offering could not be saved';
  END IF;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    application.user_id,
    'student.qualification_admitted',
    pg_catalog.jsonb_build_object(
      'application_id', application.id,
      'qualification_offering_id', p_qualification_offering_id,
      'study_year', p_study_year
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_college_student_application_with_qualification(uuid, uuid, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_college_student_application_with_qualification(uuid, uuid, integer, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_department_timetable(
  p_department_id uuid,
  p_academic_year text,
  p_term smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  active_offering_count bigint;
  slots_created bigint := 0;
  enrollments_created bigint := 0;
  offering_row record;
  candidate_day integer;
  candidate_start time;
  candidate_room text;
  class_duration interval;
  slot_placed boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'Only authorized academic staff can generate department timetables'
      USING ERRCODE = '42501';
  END IF;

  IF p_department_id IS NULL
     OR NULLIF(pg_catalog.btrim(p_academic_year), '') IS NULL
     OR p_term IS NULL
     OR p_term < 1 THEN
    RAISE EXCEPTION 'Choose a department, academic year, and valid term'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_departments AS department
    WHERE department.id = p_department_id
      AND department.is_active
  ) THEN
    RAISE EXCEPTION 'The selected department does not exist or is inactive';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 2);

  SELECT pg_catalog.count(*)
    INTO active_offering_count
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term;

  IF active_offering_count = 0 THEN
    RAISE EXCEPTION 'No active subject classes were found for the selected department, academic year, and term';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND course.credit_hours NOT IN (1, 2)
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_timetable_slots AS existing_slot
        WHERE existing_slot.course_offering_id = offering.id
          AND existing_slot.slot_status = 'scheduled'
      )
  ) THEN
    RAISE EXCEPTION 'Automatic scheduling requires every unscheduled subject to have 1 or 2 credit hours';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_qualification_subjects AS subject
        WHERE subject.course_id = course.id
          AND subject.term = offering.term
      )
  ) THEN
    RAISE EXCEPTION 'Assign every active subject class to a course offering for its term before generating the timetable';
  END IF;

  FOR offering_row IN
    SELECT offering.id, offering.lecturer_id, course.credit_hours
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_timetable_slots AS existing_slot
        WHERE existing_slot.course_offering_id = offering.id
          AND existing_slot.slot_status = 'scheduled'
      )
    ORDER BY course.code, offering.section, offering.id
  LOOP
    class_duration := offering_row.credit_hours * INTERVAL '1 hour';
    slot_placed := false;

    FOR candidate_day IN 1..5 LOOP
      candidate_start := TIME '08:00';

      WHILE candidate_start + class_duration <= TIME '17:00' LOOP
        FOR candidate_room IN
          SELECT available_room.room
          FROM (
            SELECT 1 AS room_type, rooms.room_number,
              'Lecture Room ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 15) AS rooms(room_number)
            UNION ALL
            SELECT 2 AS room_type, rooms.room_number,
              'Seminar Room ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 10) AS rooms(room_number)
            UNION ALL
            SELECT 3 AS room_type, rooms.room_number,
              'Lecture Theater ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 8) AS rooms(room_number)
          ) AS available_room
          ORDER BY available_room.room_type, available_room.room_number
        LOOP
          IF NOT EXISTS (
            SELECT 1
            FROM public.college_timetable_slots AS existing_slot
            JOIN public.college_course_offerings AS existing_offering
              ON existing_offering.id = existing_slot.course_offering_id
            WHERE existing_slot.slot_status = 'scheduled'
              AND existing_slot.day_of_week = candidate_day
              AND existing_offering.academic_year = pg_catalog.btrim(p_academic_year)
              AND existing_offering.term = p_term
              AND candidate_start < existing_slot.ends_at
              AND candidate_start + class_duration > existing_slot.starts_at
              AND (
                existing_slot.course_offering_id = offering_row.id
                OR (
                  offering_row.lecturer_id IS NOT NULL
                  AND existing_offering.lecturer_id = offering_row.lecturer_id
                )
                OR pg_catalog.lower(pg_catalog.btrim(existing_slot.room))
                  = pg_catalog.lower(pg_catalog.btrim(candidate_room))
              )
          ) THEN
            INSERT INTO public.college_timetable_slots (
              course_offering_id, day_of_week, starts_at, ends_at, room
            )
            VALUES (
              offering_row.id,
              candidate_day,
              candidate_start,
              candidate_start + class_duration,
              candidate_room
            );

            slots_created := slots_created + 1;
            slot_placed := true;
            EXIT;
          END IF;
        END LOOP;

        EXIT WHEN slot_placed;
        candidate_start := candidate_start + INTERVAL '1 hour';
      END LOOP;

      EXIT WHEN slot_placed;
    END LOOP;

    IF NOT slot_placed THEN
      RAISE EXCEPTION 'No conflict-free timetable slot could be found for subject class %. No timetable or enrollment changes were saved.',
        offering_row.id
        USING ERRCODE = '23P01';
    END IF;
  END LOOP;

  INSERT INTO public.college_enrollments (
    student_id, course_offering_id, enrollment_status
  )
  SELECT DISTINCT student.id, offering.id, 'enrolled'
  FROM public.college_course_offerings AS offering
  JOIN public.college_courses AS course
    ON course.id = offering.course_id
  JOIN public.college_qualification_subjects AS assigned_subject
    ON assigned_subject.course_id = course.id
   AND assigned_subject.term = offering.term
  JOIN public.college_students AS student
    ON student.qualification_offering_id = assigned_subject.qualification_offering_id
   AND student.department_id = course.department_id
   AND student.study_year = assigned_subject.study_year
  JOIN public.college_profiles AS profile
    ON profile.id = student.id
  WHERE course.department_id = p_department_id
    AND course.is_active
    AND offering.academic_year = pg_catalog.btrim(p_academic_year)
    AND offering.term = p_term
    AND offering.student_selection_open
    AND student.student_status = 'active'
    AND profile.role = 'student'
    AND EXISTS (
      SELECT 1
      FROM public.college_timetable_slots AS scheduled_slot
      WHERE scheduled_slot.course_offering_id = offering.id
        AND scheduled_slot.slot_status = 'scheduled'
    )
  ON CONFLICT (student_id, course_offering_id) DO NOTHING;

  GET DIAGNOSTICS enrollments_created = ROW_COUNT;

  INSERT INTO public.college_audit_events (actor_id, action, details)
  VALUES (
    actor_id,
    'timetable.department_generated',
    pg_catalog.jsonb_build_object(
      'department_id', p_department_id,
      'academic_year', pg_catalog.btrim(p_academic_year),
      'term', p_term,
      'slots_created', slots_created,
      'enrollments_created', enrollments_created
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'slots_created', slots_created,
    'enrollments_created', enrollments_created,
    'offerings_processed', active_offering_count
  );
END;
$$;

DROP POLICY IF EXISTS college_courses_read ON public.college_courses;
CREATE POLICY college_courses_read
  ON public.college_courses FOR SELECT TO authenticated
  USING (
    (
      NOT public.stj_has_role(
        ARRAY['student', 'pending']::public.stj_college_role[]
      )
    )
    OR (
      public.stj_has_role(ARRAY['pending']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_course_offerings AS offering
        WHERE offering.course_id = college_courses.id
          AND offering.student_selection_open
          AND college_courses.is_active
      )
    )
    OR (
      public.stj_has_role(ARRAY['student']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_students AS student
        JOIN public.college_course_study_years AS course_year
          ON course_year.study_year = student.study_year
        WHERE student.id = (SELECT auth.uid())
          AND student.department_id = college_courses.department_id
          AND course_year.course_id = college_courses.id
      )
    )
    OR (
      public.stj_has_role(ARRAY['student']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_students AS student
        JOIN public.college_qualification_subjects AS subject
          ON subject.qualification_offering_id = student.qualification_offering_id
         AND subject.study_year = student.study_year
        WHERE student.id = (SELECT auth.uid())
          AND student.department_id = college_courses.department_id
          AND subject.course_id = college_courses.id
      )
    )
    OR (
      public.stj_has_role(ARRAY['student']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_enrollments AS enrollment
        JOIN public.college_course_offerings AS offering
          ON offering.id = enrollment.course_offering_id
        WHERE enrollment.student_id = (SELECT auth.uid())
          AND enrollment.enrollment_status = 'enrolled'
          AND offering.course_id = college_courses.id
      )
    )
  );

REVOKE ALL ON FUNCTION public.select_college_course_offering(uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_college_qualification_subject(uuid, uuid, smallint, smallint, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_college_qualification_subject(uuid, uuid, smallint, smallint, boolean)
  TO authenticated;

REVOKE ALL ON FUNCTION public.generate_department_timetable(uuid, text, smallint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_department_timetable(uuid, text, smallint)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
