BEGIN;

ALTER TABLE public.college_student_applications
  ADD COLUMN study_year smallint;

ALTER TABLE public.college_students
  ADD COLUMN study_year smallint;

ALTER TABLE public.college_student_applications
  ADD CONSTRAINT college_student_applications_study_year_check
  CHECK (study_year IS NULL OR study_year > 0);

ALTER TABLE public.college_students
  ADD CONSTRAINT college_students_study_year_check
  CHECK (study_year IS NULL OR study_year > 0);

CREATE TABLE public.college_programme_year_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES public.college_programmes (id) ON DELETE RESTRICT,
  study_year smallint NOT NULL CHECK (study_year > 0),
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.college_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, study_year, course_offering_id)
);

CREATE TABLE public.college_programme_year_enrollment_sources (
  student_id uuid NOT NULL,
  course_offering_id uuid NOT NULL,
  PRIMARY KEY (student_id, course_offering_id),
  FOREIGN KEY (student_id, course_offering_id)
    REFERENCES public.college_enrollments (student_id, course_offering_id)
    ON DELETE CASCADE
);

ALTER TABLE public.college_programme_year_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_programme_year_enrollment_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY college_programme_year_offerings_read
  ON public.college_programme_year_offerings FOR SELECT TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
  );

CREATE POLICY college_programme_year_offerings_insert
  ON public.college_programme_year_offerings FOR INSERT TO authenticated
  WITH CHECK (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
  );

CREATE POLICY college_programme_year_offerings_delete
  ON public.college_programme_year_offerings FOR DELETE TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
  );

REVOKE ALL ON TABLE
  public.college_programme_year_offerings,
  public.college_programme_year_enrollment_sources
FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.college_programme_year_offerings TO authenticated;

CREATE OR REPLACE FUNCTION public.stj_validate_programme_study_year(
  p_programme_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  programme_duration smallint;
BEGIN
  IF p_study_year IS NULL OR p_study_year < 1 THEN
    RAISE EXCEPTION 'Choose a valid year of study';
  END IF;

  SELECT programme.duration_years
    INTO programme_duration
    FROM public.college_programmes AS programme
    WHERE programme.id = p_programme_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected programme does not exist';
  END IF;

  IF programme_duration IS NOT NULL AND p_study_year > programme_duration THEN
    RAISE EXCEPTION 'The year of study exceeds the programme duration';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.stj_validate_programme_study_year(uuid, integer)
  FROM PUBLIC, anon, authenticated;

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
  p_documents jsonb,
  p_study_year integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  application_id uuid;
BEGIN
  PERFORM public.stj_validate_programme_study_year(p_programme_id, p_study_year);

  application_id := public.submit_college_student_application(
    p_full_name,
    p_phone,
    p_date_of_birth,
    p_gender,
    p_home_address,
    p_emergency_contact_name,
    p_emergency_contact_phone,
    p_programme_id,
    p_photo_path,
    p_documents
  );

  UPDATE public.college_student_applications
    SET study_year = p_study_year
    WHERE id = application_id
      AND user_id = auth.uid()
      AND application_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student application could not be updated with its year of study';
  END IF;

  RETURN application_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_college_student_application(
  text, text, date, text, text, text, text, uuid, text, jsonb, integer
) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_college_student_application_study_year(
  p_application_id uuid,
  p_study_year integer
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
    RAISE EXCEPTION 'You are not allowed to update this application'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application
    FROM public.college_student_applications
    WHERE id = p_application_id
    FOR UPDATE;

  IF NOT FOUND OR application.application_status <> 'pending' THEN
    RAISE EXCEPTION 'The student application is missing or is no longer pending';
  END IF;

  PERFORM public.stj_validate_programme_study_year(
    application.programme_id,
    p_study_year
  );

  UPDATE public.college_student_applications
    SET study_year = p_study_year
    WHERE id = application.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_college_student_study_year(
  p_student_id uuid,
  p_study_year integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_programme_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'You are not allowed to update this student'
      USING ERRCODE = '42501';
  END IF;

  SELECT student.programme_id
    INTO student_programme_id
    FROM public.college_students AS student
    WHERE student.id = p_student_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student record does not exist';
  END IF;

  PERFORM public.stj_validate_programme_study_year(
    student_programme_id,
    p_study_year
  );

  UPDATE public.college_students
    SET study_year = p_study_year
    WHERE id = p_student_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_student_application_study_year(uuid, integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_college_student_study_year(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_student_application_study_year(uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_college_student_study_year(uuid, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.stj_set_student_study_year_from_application()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  application_year smallint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.application_id IS NOT NULL THEN
    SELECT application.study_year
      INTO application_year
      FROM public.college_student_applications AS application
      WHERE application.id = NEW.application_id
        AND application.user_id = NEW.id;

    IF application_year IS NULL THEN
      RAISE EXCEPTION 'Set the student application year of study before approval';
    END IF;

    NEW.study_year := application_year;
  END IF;

  IF NEW.study_year IS NOT NULL THEN
    PERFORM public.stj_validate_programme_study_year(
      NEW.programme_id,
      NEW.study_year
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER college_students_set_study_year
  BEFORE INSERT OR UPDATE OF application_id, programme_id, study_year
  ON public.college_students
  FOR EACH ROW
  EXECUTE FUNCTION public.stj_set_student_study_year_from_application();

REVOKE ALL ON FUNCTION public.stj_set_student_study_year_from_application()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stj_sync_student_programme_year_enrollments(
  p_student_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student public.college_students%ROWTYPE;
  selected_offering_id uuid;
  new_enrollment_id uuid;
BEGIN
  SELECT * INTO student
    FROM public.college_students
    WHERE id = p_student_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  WITH removed_sources AS (
    DELETE FROM public.college_programme_year_enrollment_sources AS source
    WHERE source.student_id = student.id
      AND (
        student.student_status <> 'active'
        OR student.study_year IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.college_programme_year_offerings AS mapping
          WHERE mapping.programme_id = student.programme_id
            AND mapping.study_year = student.study_year
            AND mapping.course_offering_id = source.course_offering_id
        )
      )
    RETURNING source.student_id, source.course_offering_id
  )
  UPDATE public.college_enrollments AS enrollment
    SET enrollment_status = 'dropped'
    FROM removed_sources AS removed
    WHERE enrollment.student_id = removed.student_id
      AND enrollment.course_offering_id = removed.course_offering_id
      AND enrollment.enrollment_status = 'enrolled';

  IF student.student_status <> 'active' OR student.study_year IS NULL THEN
    RETURN;
  END IF;

  FOR selected_offering_id IN
    SELECT mapping.course_offering_id
    FROM public.college_programme_year_offerings AS mapping
    WHERE mapping.programme_id = student.programme_id
      AND mapping.study_year = student.study_year
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.college_programme_year_enrollment_sources AS source
      WHERE source.student_id = student.id
        AND source.course_offering_id = selected_offering_id
    ) THEN
      UPDATE public.college_enrollments
        SET enrollment_status = 'enrolled'
        WHERE student_id = student.id
          AND course_offering_id = selected_offering_id
          AND enrollment_status = 'dropped';
      CONTINUE;
    END IF;

    new_enrollment_id := NULL;
    INSERT INTO public.college_enrollments (
      student_id, course_offering_id, enrollment_status
    )
    VALUES (student.id, selected_offering_id, 'enrolled')
    ON CONFLICT (student_id, course_offering_id) DO NOTHING
    RETURNING id INTO new_enrollment_id;

    IF new_enrollment_id IS NOT NULL THEN
      INSERT INTO public.college_programme_year_enrollment_sources (
        student_id, course_offering_id
      )
      VALUES (student.id, selected_offering_id);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.stj_sync_student_programme_year_enrollments(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stj_sync_student_programme_year_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.stj_sync_student_programme_year_enrollments(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER college_students_sync_programme_year_enrollments
  AFTER INSERT OR UPDATE OF programme_id, study_year, student_status
  ON public.college_students
  FOR EACH ROW
  EXECUTE FUNCTION public.stj_sync_student_programme_year_after_change();

REVOKE ALL ON FUNCTION public.stj_sync_student_programme_year_after_change()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stj_sync_students_after_programme_year_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_id uuid;
BEGIN
  PERFORM public.stj_validate_programme_study_year(
    NEW.programme_id,
    NEW.study_year
  );

  FOR student_id IN
    SELECT student.id
    FROM public.college_students AS student
    WHERE student.programme_id = NEW.programme_id
      AND student.study_year = NEW.study_year
      AND student.student_status = 'active'
    ORDER BY student.id
  LOOP
    PERFORM public.stj_sync_student_programme_year_enrollments(student_id);
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stj_sync_students_after_programme_year_mapping()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER college_programme_year_offerings_sync_students
  AFTER INSERT ON public.college_programme_year_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.stj_sync_students_after_programme_year_mapping();

CREATE OR REPLACE FUNCTION public.stj_sync_students_after_programme_year_unmapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_id uuid;
BEGIN
  FOR student_id IN
    SELECT student.id
    FROM public.college_students AS student
    WHERE student.programme_id = OLD.programme_id
      AND student.study_year = OLD.study_year
    ORDER BY student.id
  LOOP
    PERFORM public.stj_sync_student_programme_year_enrollments(student_id);
  END LOOP;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.stj_sync_students_after_programme_year_unmapping()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER college_programme_year_offerings_unmap_students
  AFTER DELETE ON public.college_programme_year_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.stj_sync_students_after_programme_year_unmapping();

CREATE OR REPLACE FUNCTION public.get_college_attendance_roster(
  p_session_id uuid
)
RETURNS TABLE (
  student_id uuid,
  full_name text,
  student_number text,
  attendance_status text,
  marked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  session_row public.college_attendance_sessions%ROWTYPE;
  is_manager boolean;
BEGIN
  is_manager := public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
  );

  SELECT session.*
    INTO session_row
    FROM public.college_attendance_sessions AS session
    WHERE session.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance session was not found';
  END IF;

  IF actor_id IS NULL OR (
    NOT is_manager
    AND NOT EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = session_row.course_offering_id
        AND offering.lecturer_id = actor_id
    )
  ) THEN
    RAISE EXCEPTION 'You are not allowed to view this class roster'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      student.id,
      profile.full_name,
      student.student_number,
      COALESCE(
        record.attendance_status,
        CASE
          WHEN session_row.session_status = 'closed'
            OR pg_catalog.clock_timestamp() >= session_row.ends_at
          THEN 'absent'
          ELSE 'not_scanned'
        END
      ),
      record.marked_at
    FROM public.college_enrollments AS enrollment
    JOIN public.college_students AS student
      ON student.id = enrollment.student_id
    LEFT JOIN public.college_profiles AS profile
      ON profile.id = student.id
    LEFT JOIN public.college_attendance_records AS record
      ON record.session_id = session_row.id
      AND record.student_id = student.id
    WHERE enrollment.course_offering_id = session_row.course_offering_id
      AND (
        enrollment.enrollment_status = 'enrolled'
        OR record.id IS NOT NULL
      )
    ORDER BY profile.full_name, student.student_number;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
