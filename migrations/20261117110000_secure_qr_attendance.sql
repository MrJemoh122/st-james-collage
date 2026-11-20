BEGIN;

ALTER TABLE public.college_attendance_sessions
  ADD COLUMN IF NOT EXISTS timetable_slot_id uuid
    REFERENCES public.college_timetable_slots (id),
  ADD COLUMN IF NOT EXISTS attendance_opens_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_after_at timestamptz,
  ADD COLUMN IF NOT EXISTS allow_late_scans boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS manual_corrections_allowed boolean NOT NULL DEFAULT true;

UPDATE public.college_attendance_sessions
  SET attendance_opens_at = starts_at
  WHERE attendance_opens_at IS NULL;

ALTER TABLE public.college_attendance_sessions
  ALTER COLUMN attendance_opens_at SET NOT NULL;

DO $attendance_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'college_attendance_sessions_late_after_check'
      AND conrelid = 'public.college_attendance_sessions'::regclass
  ) THEN
    ALTER TABLE public.college_attendance_sessions
      ADD CONSTRAINT college_attendance_sessions_late_after_check
      CHECK (
        late_after_at IS NULL
        OR late_after_at BETWEEN attendance_opens_at AND ends_at
      );
  END IF;
END;
$attendance_constraints$;

CREATE TABLE IF NOT EXISTS public.college_attendance_qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL
    REFERENCES public.college_attendance_sessions (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES public.college_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS college_attendance_qr_tokens_one_active_idx
  ON public.college_attendance_qr_tokens (session_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS college_attendance_qr_tokens_expiry_idx
  ON public.college_attendance_qr_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.college_attendance_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL
    REFERENCES public.college_attendance_sessions (id) ON DELETE CASCADE,
  record_id uuid REFERENCES public.college_attendance_records (id) ON DELETE SET NULL,
  actor_id uuid REFERENCES public.college_profiles (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (
    action IN (
      'session_started',
      'token_rotated',
      'scan_submitted',
      'session_closed',
      'attendance_corrected'
    )
  ),
  old_status text,
  new_status text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS college_attendance_audit_logs_session_idx
  ON public.college_attendance_audit_logs (session_id, created_at DESC);

ALTER TABLE public.college_attendance_qr_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_attendance_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_attendance_sessions_insert
  ON public.college_attendance_sessions;
DROP POLICY IF EXISTS college_attendance_sessions_update
  ON public.college_attendance_sessions;
DROP POLICY IF EXISTS college_attendance_records_insert
  ON public.college_attendance_records;
DROP POLICY IF EXISTS college_attendance_records_update
  ON public.college_attendance_records;

CREATE POLICY college_attendance_audit_logs_read
  ON public.college_attendance_audit_logs FOR SELECT TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
    )
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = (
        SELECT session.course_offering_id
        FROM public.college_attendance_sessions AS session
        WHERE session.id = session_id
      )
      AND offering.lecturer_id = (SELECT auth.uid())
    )
  );

REVOKE ALL ON TABLE
  public.college_attendance_qr_tokens,
  public.college_attendance_audit_logs
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.college_attendance_audit_logs TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON
  public.college_attendance_sessions,
  public.college_attendance_records
FROM PUBLIC, anon, authenticated;

REVOKE SELECT ON public.college_attendance_sessions
FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  course_offering_id,
  created_by,
  starts_at,
  ends_at,
  session_status,
  qr_expires_at,
  created_at,
  updated_at,
  timetable_slot_id,
  attendance_opens_at,
  late_after_at,
  allow_late_scans,
  manual_corrections_allowed
) ON public.college_attendance_sessions TO authenticated;
GRANT SELECT ON public.college_attendance_records TO authenticated;

CREATE OR REPLACE FUNCTION public.rotate_college_attendance_qr_token(
  p_session_id uuid
)
RETURNS TABLE (plaintext_token text, token_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  session_row public.college_attendance_sessions%ROWTYPE;
  new_token text;
  new_token_hash text;
  new_expiry timestamptz;
  is_manager boolean;
BEGIN
  is_manager := public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
  );

  SELECT session.*
    INTO session_row
    FROM public.college_attendance_sessions AS session
    WHERE session.id = p_session_id
    FOR UPDATE;

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
    RAISE EXCEPTION 'You are not allowed to manage this attendance session'
      USING ERRCODE = '42501';
  END IF;

  IF session_row.session_status <> 'open'
     OR pg_catalog.clock_timestamp() >= session_row.ends_at THEN
    RAISE EXCEPTION 'The attendance session is closed or has expired';
  END IF;

  UPDATE public.college_attendance_qr_tokens
    SET revoked_at = pg_catalog.clock_timestamp()
    WHERE session_id = p_session_id
      AND revoked_at IS NULL;

  new_token := pg_catalog.replace(
    pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text,
    '-',
    ''
  );
  new_expiry := LEAST(
    session_row.ends_at,
    pg_catalog.clock_timestamp() + interval '2 minutes'
  );
  new_token_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(new_token, 'UTF8')),
    'hex'
  );

  INSERT INTO public.college_attendance_qr_tokens (
    session_id, token_hash, created_by, expires_at
  )
  VALUES (
    p_session_id,
    new_token_hash,
    actor_id,
    new_expiry
  );

  UPDATE public.college_attendance_sessions
    SET qr_token_hash = new_token_hash,
        qr_expires_at = new_expiry,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_session_id;

  INSERT INTO public.college_attendance_audit_logs (
    session_id, actor_id, action, details
  )
  VALUES (
    p_session_id,
    actor_id,
    'token_rotated',
    pg_catalog.jsonb_build_object('expires_at', new_expiry)
  );

  RETURN QUERY SELECT new_token, new_expiry;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_college_attendance_session(
  p_course_offering_id uuid,
  p_timetable_slot_id uuid,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_late_after_at timestamptz,
  p_allow_late_scans boolean,
  p_manual_corrections_allowed boolean
)
RETURNS TABLE (
  attendance_session_id uuid,
  plaintext_token text,
  token_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  is_manager boolean;
  lecturer_id uuid;
  created_session_id uuid;
  new_token text;
  new_token_hash text;
  new_expiry timestamptz;
BEGIN
  is_manager := public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
  );

  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated lecturer or administrator is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT offering.lecturer_id
    INTO lecturer_id
    FROM public.college_course_offerings AS offering
    WHERE offering.id = p_course_offering_id
    FOR SHARE;

  IF NOT FOUND OR (
    NOT is_manager AND lecturer_id IS DISTINCT FROM actor_id
  ) THEN
    RAISE EXCEPTION 'You are not assigned to this course offering'
      USING ERRCODE = '42501';
  END IF;

  IF p_timetable_slot_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.college_timetable_slots AS slot
    WHERE slot.id = p_timetable_slot_id
      AND slot.course_offering_id = p_course_offering_id
  ) THEN
    RAISE EXCEPTION 'Select a timetable slot assigned to this course';
  END IF;

  IF p_opens_at IS NULL
     OR p_closes_at IS NULL
     OR p_late_after_at IS NULL
     OR p_opens_at >= p_closes_at
     OR p_late_after_at < p_opens_at
     OR p_late_after_at > p_closes_at
     OR p_closes_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Attendance opening, late, and closing times are invalid';
  END IF;

  INSERT INTO public.college_attendance_sessions (
    course_offering_id,
    created_by,
    starts_at,
    ends_at,
    session_status,
    timetable_slot_id,
    attendance_opens_at,
    late_after_at,
    allow_late_scans,
    manual_corrections_allowed
  )
  VALUES (
    p_course_offering_id,
    actor_id,
    p_opens_at,
    p_closes_at,
    'open',
    p_timetable_slot_id,
    p_opens_at,
    p_late_after_at,
    COALESCE(p_allow_late_scans, false),
    COALESCE(p_manual_corrections_allowed, false)
  )
  RETURNING id INTO created_session_id;

  new_token := pg_catalog.replace(
    pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text,
    '-',
    ''
  );
  new_expiry := LEAST(
    p_closes_at,
    pg_catalog.clock_timestamp() + interval '2 minutes'
  );
  new_token_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(new_token, 'UTF8')),
    'hex'
  );

  INSERT INTO public.college_attendance_qr_tokens (
    session_id, token_hash, created_by, expires_at
  )
  VALUES (
    created_session_id,
    new_token_hash,
    actor_id,
    new_expiry
  );

  UPDATE public.college_attendance_sessions
    SET qr_token_hash = new_token_hash,
        qr_expires_at = new_expiry,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = created_session_id;

  INSERT INTO public.college_attendance_audit_logs (
    session_id, actor_id, action, details
  )
  VALUES (
    created_session_id,
    actor_id,
    'session_started',
    pg_catalog.jsonb_build_object(
      'course_offering_id', p_course_offering_id,
      'timetable_slot_id', p_timetable_slot_id,
      'opens_at', p_opens_at,
      'closes_at', p_closes_at,
      'late_after_at', p_late_after_at
    )
  );

  RETURN QUERY SELECT created_session_id, new_token, new_expiry;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_college_attendance_scan(
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  session_row public.college_attendance_sessions%ROWTYPE;
  token_row public.college_attendance_qr_tokens%ROWTYPE;
  scan_time timestamptz;
  record_id uuid;
  attendance_state text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in with a student account to submit attendance'
      USING ERRCODE = '42501';
  END IF;

  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'This QR code is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_students AS student
    JOIN public.college_profiles AS profile ON profile.id = student.id
    WHERE student.id = actor_id
      AND student.student_status = 'active'
      AND profile.role = 'student'
  ) THEN
    RAISE EXCEPTION 'Only an active student account can submit attendance'
      USING ERRCODE = '42501';
  END IF;

  SELECT token.*
    INTO token_row
    FROM public.college_attendance_qr_tokens AS token
    WHERE token.token_hash = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')),
      'hex'
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This QR code is invalid';
  END IF;

  SELECT session.*
    INTO session_row
    FROM public.college_attendance_sessions AS session
    WHERE session.id = token_row.session_id
    FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This attendance session no longer exists';
  END IF;

  SELECT token.*
    INTO token_row
    FROM public.college_attendance_qr_tokens AS token
    WHERE token.id = token_row.id
    FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This QR code is no longer valid';
  END IF;

  scan_time := pg_catalog.clock_timestamp();

  IF token_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This QR code was rotated. Scan the current code';
  END IF;

  IF token_row.expires_at <= scan_time THEN
    RAISE EXCEPTION 'This QR code has expired. Ask the lecturer to rotate it';
  END IF;

  IF session_row.session_status <> 'open'
     OR session_row.ends_at <= scan_time THEN
    RAISE EXCEPTION 'Attendance for this session is closed';
  END IF;

  IF session_row.attendance_opens_at > scan_time THEN
    RAISE EXCEPTION 'Attendance has not opened yet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_enrollments AS enrollment
    WHERE enrollment.student_id = actor_id
      AND enrollment.course_offering_id = session_row.course_offering_id
      AND enrollment.enrollment_status = 'enrolled'
  ) THEN
    RAISE EXCEPTION 'You are not enrolled in this course session'
      USING ERRCODE = '42501';
  END IF;

  IF scan_time >= session_row.late_after_at
     AND NOT session_row.allow_late_scans THEN
    RAISE EXCEPTION 'The late scan window is closed';
  END IF;

  attendance_state := CASE
    WHEN scan_time >= session_row.late_after_at THEN 'late'
    ELSE 'present'
  END;

  INSERT INTO public.college_attendance_records (
    session_id, student_id, attendance_status, marked_by, marked_at
  )
  VALUES (
    session_row.id, actor_id, attendance_state, actor_id, scan_time
  )
  ON CONFLICT (session_id, student_id) DO NOTHING
  RETURNING id INTO record_id;

  IF record_id IS NULL THEN
    RAISE EXCEPTION 'Attendance has already been recorded for this session';
  END IF;

  INSERT INTO public.college_attendance_audit_logs (
    session_id, record_id, actor_id, action, new_status
  )
  VALUES (
    session_row.id, record_id, actor_id, 'scan_submitted', attendance_state
  );

  RETURN pg_catalog.jsonb_build_object(
    'session_id', session_row.id,
    'status', attendance_state,
    'marked_at', scan_time
  );
END;
$$;

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
      AND enrollment.enrollment_status = 'enrolled'
    ORDER BY profile.full_name, student.student_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_college_attendance_audit(
  p_session_id uuid
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  action text,
  actor_name text,
  student_name text,
  student_number text,
  old_status text,
  new_status text,
  reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  course_offering_id uuid;
BEGIN
  SELECT session.course_offering_id
    INTO course_offering_id
    FROM public.college_attendance_sessions AS session
    WHERE session.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance session was not found';
  END IF;

  IF actor_id IS NULL OR (
    NOT public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = actor_id
    )
  ) THEN
    RAISE EXCEPTION 'You are not allowed to view this attendance audit trail'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      audit.id,
      audit.created_at,
      audit.action,
      actor.full_name,
      student_profile.full_name,
      student.student_number,
      audit.old_status,
      audit.new_status,
      audit.reason
    FROM public.college_attendance_audit_logs AS audit
    LEFT JOIN public.college_profiles AS actor
      ON actor.id = audit.actor_id
    LEFT JOIN public.college_attendance_records AS record
      ON record.id = audit.record_id
    LEFT JOIN public.college_students AS student
      ON student.id = record.student_id
    LEFT JOIN public.college_profiles AS student_profile
      ON student_profile.id = student.id
    WHERE audit.session_id = p_session_id
    ORDER BY audit.created_at DESC
    LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_college_attendance_session(
  p_session_id uuid
)
RETURNS void
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
    WHERE session.id = p_session_id
    FOR UPDATE;

  IF NOT FOUND OR session_row.session_status <> 'open' THEN
    RAISE EXCEPTION 'Attendance session is missing or already closed';
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
    RAISE EXCEPTION 'You are not allowed to close this attendance session'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.college_attendance_sessions
    SET session_status = 'closed',
        qr_token_hash = NULL,
        qr_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_session_id;

  UPDATE public.college_attendance_qr_tokens
    SET revoked_at = pg_catalog.clock_timestamp()
    WHERE session_id = p_session_id
      AND revoked_at IS NULL;

  INSERT INTO public.college_attendance_records (
    session_id, student_id, attendance_status, marked_by, marked_at
  )
  SELECT
    p_session_id,
    enrollment.student_id,
    'absent',
    actor_id,
    pg_catalog.clock_timestamp()
  FROM public.college_enrollments AS enrollment
  WHERE enrollment.course_offering_id = session_row.course_offering_id
    AND enrollment.enrollment_status = 'enrolled'
  ON CONFLICT (session_id, student_id) DO NOTHING;

  INSERT INTO public.college_attendance_audit_logs (
    session_id, actor_id, action
  )
  VALUES (p_session_id, actor_id, 'session_closed');
END;
$$;

CREATE OR REPLACE FUNCTION public.correct_college_attendance_record(
  p_session_id uuid,
  p_student_id uuid,
  p_new_status text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  record_row public.college_attendance_records%ROWTYPE;
  session_row public.college_attendance_sessions%ROWTYPE;
  is_manager boolean;
  previous_status text;
BEGIN
  is_manager := public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
  );

  IF actor_id IS NULL OR p_new_status NOT IN ('present', 'late', 'absent', 'excused')
     OR p_reason IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_reason)) < 5
     OR pg_catalog.length(pg_catalog.btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'A valid attendance status and correction reason are required';
  END IF;

  SELECT session.*
    INTO session_row
    FROM public.college_attendance_sessions AS session
    WHERE session.id = p_session_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance session was not found';
  END IF;

  IF NOT is_manager AND NOT EXISTS (
    SELECT 1
    FROM public.college_course_offerings AS offering
    WHERE offering.id = session_row.course_offering_id
      AND offering.lecturer_id = actor_id
  ) THEN
    RAISE EXCEPTION 'You are not allowed to correct attendance for this session'
      USING ERRCODE = '42501';
  END IF;

  IF NOT session_row.manual_corrections_allowed THEN
    RAISE EXCEPTION 'Manual attendance corrections are disabled for this session';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_enrollments AS enrollment
    WHERE enrollment.student_id = p_student_id
      AND enrollment.course_offering_id = session_row.course_offering_id
      AND enrollment.enrollment_status = 'enrolled'
  ) THEN
    RAISE EXCEPTION 'The student is not enrolled in this course session';
  END IF;

  SELECT record.*
    INTO record_row
    FROM public.college_attendance_records AS record
    WHERE record.session_id = p_session_id
      AND record.student_id = p_student_id
    FOR UPDATE;

  IF FOUND THEN
    previous_status := record_row.attendance_status;
    UPDATE public.college_attendance_records
      SET attendance_status = p_new_status,
          marked_by = actor_id,
          marked_at = pg_catalog.clock_timestamp()
      WHERE id = record_row.id;
  ELSE
    INSERT INTO public.college_attendance_records (
      session_id, student_id, attendance_status, marked_by, marked_at
    )
    VALUES (
      p_session_id, p_student_id, p_new_status, actor_id, pg_catalog.clock_timestamp()
    )
    RETURNING * INTO record_row;
  END IF;

  INSERT INTO public.college_attendance_audit_logs (
    session_id, record_id, actor_id, action, old_status, new_status, reason
  )
  VALUES (
    p_session_id,
    record_row.id,
    actor_id,
    'attendance_corrected',
    previous_status,
    p_new_status,
    pg_catalog.btrim(p_reason)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_college_attendance_report(
  p_start_at timestamptz DEFAULT NULL,
  p_end_at timestamptz DEFAULT NULL,
  p_student_search text DEFAULT NULL,
  p_course_search text DEFAULT NULL,
  p_course_offering_id uuid DEFAULT NULL,
  p_section text DEFAULT NULL,
  p_lecturer_search text DEFAULT NULL,
  p_department_search text DEFAULT NULL,
  p_lecturer_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL,
  p_academic_year text DEFAULT NULL,
  p_term smallint DEFAULT NULL
)
RETURNS TABLE (
  session_id uuid,
  session_start timestamptz,
  full_name text,
  student_number text,
  attendance_status text,
  marked_at timestamptz,
  course_code text,
  course_name text,
  section text,
  lecturer_name text,
  department_name text,
  academic_year text,
  term smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  is_manager boolean;
BEGIN
  is_manager := public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[]
  );

  IF actor_id IS NULL OR (
    NOT is_manager
    AND NOT EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.lecturer_id = actor_id
    )
  ) THEN
    RAISE EXCEPTION 'You are not allowed to view attendance reports'
      USING ERRCODE = '42501';
  END IF;

  IF p_start_at IS NOT NULL AND p_end_at IS NOT NULL
     AND p_start_at >= p_end_at THEN
    RAISE EXCEPTION 'The report start time must be earlier than its end time';
  END IF;

  RETURN QUERY
    SELECT
      record.session_id,
      session.starts_at,
      profile.full_name,
      student.student_number,
      record.attendance_status,
      record.marked_at,
      course.code,
      course.name,
      offering.section,
      lecturer_profile.full_name,
      department.name,
      offering.academic_year,
      offering.term
    FROM public.college_attendance_records AS record
    JOIN public.college_attendance_sessions AS session
      ON session.id = record.session_id
    JOIN public.college_course_offerings AS offering
      ON offering.id = session.course_offering_id
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    JOIN public.college_departments AS department
      ON department.id = course.department_id
    JOIN public.college_students AS student
      ON student.id = record.student_id
    JOIN public.college_profiles AS profile
      ON profile.id = student.id
    LEFT JOIN public.college_staff AS lecturer
      ON lecturer.id = offering.lecturer_id
    LEFT JOIN public.college_profiles AS lecturer_profile
      ON lecturer_profile.id = lecturer.id
    WHERE (is_manager OR offering.lecturer_id = actor_id)
      AND (p_start_at IS NULL OR session.starts_at >= p_start_at)
      AND (p_end_at IS NULL OR session.starts_at < p_end_at)
      AND (p_student_search IS NULL OR
        profile.full_name ILIKE '%' || p_student_search || '%'
        OR student.student_number ILIKE '%' || p_student_search || '%')
      AND (p_course_search IS NULL OR
        course.code ILIKE '%' || p_course_search || '%'
        OR course.name ILIKE '%' || p_course_search || '%')
      AND (p_course_offering_id IS NULL OR offering.id = p_course_offering_id)
      AND (p_section IS NULL OR offering.section = p_section)
      AND (p_lecturer_search IS NULL OR
        lecturer_profile.full_name ILIKE '%' || p_lecturer_search || '%')
      AND (p_department_search IS NULL OR
        department.name ILIKE '%' || p_department_search || '%')
      AND (p_lecturer_id IS NULL OR offering.lecturer_id = p_lecturer_id)
      AND (p_department_id IS NULL OR course.department_id = p_department_id)
      AND (p_academic_year IS NULL OR offering.academic_year = p_academic_year)
      AND (p_term IS NULL OR offering.term = p_term)
    ORDER BY session.starts_at DESC, profile.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_college_attendance_qr_token(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_college_attendance_session(uuid, uuid, timestamptz, timestamptz, timestamptz, boolean, boolean)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_college_attendance_scan(text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_college_attendance_roster(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_college_attendance_audit(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_college_attendance_session(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.correct_college_attendance_record(uuid, uuid, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_college_attendance_report(timestamptz, timestamptz, text, text, uuid, text, text, text, uuid, uuid, text, smallint)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rotate_college_attendance_qr_token(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_college_attendance_session(uuid, uuid, timestamptz, timestamptz, timestamptz, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_college_attendance_scan(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_college_attendance_roster(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_college_attendance_audit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_college_attendance_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_college_attendance_record(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_college_attendance_report(timestamptz, timestamptz, text, text, uuid, text, text, text, uuid, uuid, text, smallint) TO authenticated;

DO $realtime_publication$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'college_attendance_records'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.college_attendance_records';
  END IF;
END;
$realtime_publication$;

COMMIT;

NOTIFY pgrst, 'reload schema';
