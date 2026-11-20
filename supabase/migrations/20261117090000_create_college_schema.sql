BEGIN;

DO $$
BEGIN
  CREATE TYPE public.stj_college_role AS ENUM (
    'pending',
    'super_admin',
    'college_admin',
    'academic_registrar',
    'department_head',
    'lecturer',
    'student',
    'finance_accountant',
    'bursar',
    'librarian',
    'examination_officer',
    'non_teaching_staff'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE public.college_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email text,
  full_name text,
  phone text,
  role public.stj_college_role NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX college_profiles_email_lower_key
  ON public.college_profiles (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE public.college_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.college_departments (id),
  code text NOT NULL,
  name text NOT NULL,
  award text,
  duration_years smallint CHECK (duration_years > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

CREATE TABLE public.college_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.college_departments (id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  credit_hours smallint NOT NULL DEFAULT 1 CHECK (credit_hours > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_staff (
  id uuid PRIMARY KEY REFERENCES public.college_profiles (id) ON DELETE CASCADE,
  staff_number text NOT NULL UNIQUE,
  department_id uuid REFERENCES public.college_departments (id),
  job_title text,
  employment_status text NOT NULL DEFAULT 'active'
    CHECK (employment_status IN ('active', 'on_leave', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_students (
  id uuid PRIMARY KEY REFERENCES public.college_profiles (id) ON DELETE CASCADE,
  student_number text NOT NULL UNIQUE,
  programme_id uuid NOT NULL REFERENCES public.college_programmes (id),
  admitted_on date,
  student_status text NOT NULL DEFAULT 'active'
    CHECK (student_status IN ('active', 'deferred', 'graduated', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_course_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.college_courses (id),
  lecturer_id uuid REFERENCES public.college_staff (id),
  academic_year text NOT NULL,
  term smallint NOT NULL CHECK (term > 0),
  section text NOT NULL DEFAULT 'A',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, academic_year, term, section)
);

CREATE TABLE public.college_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id),
  enrollment_status text NOT NULL DEFAULT 'enrolled'
    CHECK (enrollment_status IN ('enrolled', 'completed', 'dropped')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, course_offering_id)
);

CREATE TABLE public.college_attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id),
  created_by uuid NOT NULL REFERENCES public.college_profiles (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  session_status text NOT NULL DEFAULT 'scheduled'
    CHECK (session_status IN ('scheduled', 'open', 'closed', 'cancelled')),
  qr_token_hash text,
  qr_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (qr_token_hash IS NULL OR qr_expires_at IS NOT NULL)
);

CREATE TABLE public.college_attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.college_attendance_sessions (id),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  attendance_status text NOT NULL
    CHECK (attendance_status IN ('present', 'late', 'absent', 'excused')),
  marked_by uuid REFERENCES public.college_profiles (id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, student_id)
);

CREATE TABLE public.college_examinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id),
  title text NOT NULL,
  scheduled_at timestamptz,
  max_score numeric(8, 2) NOT NULL CHECK (max_score > 0),
  exam_status text NOT NULL DEFAULT 'scheduled'
    CHECK (exam_status IN ('scheduled', 'open', 'closed', 'cancelled')),
  created_by uuid NOT NULL REFERENCES public.college_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_exam_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  examination_id uuid NOT NULL REFERENCES public.college_examinations (id),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  score numeric(8, 2) NOT NULL CHECK (score >= 0),
  graded_by uuid NOT NULL REFERENCES public.college_profiles (id),
  graded_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (examination_id, student_id)
);

CREATE TABLE public.college_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  description text NOT NULL,
  academic_year text NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'TZS' CHECK (currency = 'TZS'),
  due_on date,
  created_by uuid REFERENCES public.college_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  charge_id uuid REFERENCES public.college_fee_charges (id),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'TZS' CHECK (currency = 'TZS'),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'confirmed', 'failed', 'reversed')),
  payment_method text,
  provider_reference text UNIQUE,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.college_library_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn text UNIQUE,
  title text NOT NULL,
  author text,
  total_copies integer NOT NULL DEFAULT 1 CHECK (total_copies >= 0),
  available_copies integer NOT NULL DEFAULT 1 CHECK (available_copies >= 0),
  shelf_location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available_copies <= total_copies)
);

CREATE TABLE public.college_library_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES public.college_library_books (id),
  student_id uuid NOT NULL REFERENCES public.college_students (id),
  issued_by uuid NOT NULL REFERENCES public.college_profiles (id),
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (returned_at IS NULL OR returned_at >= checked_out_at)
);

CREATE TABLE public.college_timetable_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  room text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE public.college_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES public.college_profiles (id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES public.college_profiles (id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX college_programmes_department_idx
  ON public.college_programmes (department_id);
CREATE INDEX college_courses_department_idx
  ON public.college_courses (department_id);
CREATE INDEX college_staff_department_idx
  ON public.college_staff (department_id);
CREATE INDEX college_students_programme_idx
  ON public.college_students (programme_id);
CREATE INDEX college_offerings_course_idx
  ON public.college_course_offerings (course_id);
CREATE INDEX college_offerings_lecturer_idx
  ON public.college_course_offerings (lecturer_id);
CREATE INDEX college_enrollments_student_idx
  ON public.college_enrollments (student_id);
CREATE INDEX college_enrollments_offering_idx
  ON public.college_enrollments (course_offering_id);
CREATE INDEX college_attendance_sessions_offering_idx
  ON public.college_attendance_sessions (course_offering_id, starts_at);
CREATE INDEX college_attendance_records_student_idx
  ON public.college_attendance_records (student_id);
CREATE INDEX college_examinations_offering_idx
  ON public.college_examinations (course_offering_id);
CREATE INDEX college_exam_results_student_idx
  ON public.college_exam_results (student_id);
CREATE INDEX college_fee_charges_student_idx
  ON public.college_fee_charges (student_id);
CREATE INDEX college_payments_student_idx
  ON public.college_payments (student_id);
CREATE INDEX college_library_loans_student_idx
  ON public.college_library_loans (student_id);
CREATE INDEX college_timetable_offering_idx
  ON public.college_timetable_slots (course_offering_id, day_of_week);
CREATE INDEX college_audit_events_created_idx
  ON public.college_audit_events (created_at DESC);

CREATE OR REPLACE FUNCTION public.stj_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER college_profiles_updated_at
  BEFORE UPDATE ON public.college_profiles
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_departments_updated_at
  BEFORE UPDATE ON public.college_departments
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_programmes_updated_at
  BEFORE UPDATE ON public.college_programmes
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_courses_updated_at
  BEFORE UPDATE ON public.college_courses
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_staff_updated_at
  BEFORE UPDATE ON public.college_staff
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_students_updated_at
  BEFORE UPDATE ON public.college_students
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_course_offerings_updated_at
  BEFORE UPDATE ON public.college_course_offerings
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_attendance_sessions_updated_at
  BEFORE UPDATE ON public.college_attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_examinations_updated_at
  BEFORE UPDATE ON public.college_examinations
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_fee_charges_updated_at
  BEFORE UPDATE ON public.college_fee_charges
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_library_books_updated_at
  BEFORE UPDATE ON public.college_library_books
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_library_loans_updated_at
  BEFORE UPDATE ON public.college_library_loans
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();
CREATE TRIGGER college_timetable_slots_updated_at
  BEFORE UPDATE ON public.college_timetable_slots
  FOR EACH ROW EXECUTE FUNCTION public.stj_set_updated_at();

CREATE OR REPLACE FUNCTION public.stj_validate_exam_result()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  maximum_score numeric(8, 2);
BEGIN
  SELECT examination.max_score
    INTO maximum_score
    FROM public.college_examinations AS examination
    WHERE examination.id = NEW.examination_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The examination does not exist or is not accessible';
  END IF;

  IF NEW.score > maximum_score THEN
    RAISE EXCEPTION 'The result cannot exceed the examination maximum score';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER college_exam_results_validate_score
  BEFORE INSERT OR UPDATE OF examination_id, score
  ON public.college_exam_results
  FOR EACH ROW EXECUTE FUNCTION public.stj_validate_exam_result();

CREATE OR REPLACE FUNCTION public.stj_create_profile_for_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.college_profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(NEW.raw_user_meta_data ->> 'full_name', '')
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stj_create_profile_after_auth_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.stj_create_profile_for_auth_user();

INSERT INTO public.college_profiles (id, email, full_name)
SELECT
  auth_user.id,
  auth_user.email,
  NULLIF(auth_user.raw_user_meta_data ->> 'full_name', '')
FROM auth.users AS auth_user
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.stj_has_role(p_roles public.stj_college_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.college_profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.role = ANY (p_roles)
  )
$$;

CREATE OR REPLACE FUNCTION public.stj_assign_college_role(
  p_user_id uuid,
  p_role public.stj_college_role
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  previous_role public.stj_college_role;
  super_admin_count integer;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(ARRAY['super_admin']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'Only a super administrator can assign roles'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = actor_id THEN
    RAISE EXCEPTION 'A super administrator cannot change their own role'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 1);

  SELECT profile.role
    INTO previous_role
    FROM public.college_profiles AS profile
    WHERE profile.id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target account has no college profile';
  END IF;

  IF previous_role = 'super_admin' AND p_role <> 'super_admin' THEN
    SELECT pg_catalog.count(*)
      INTO super_admin_count
      FROM public.college_profiles AS profile
      WHERE profile.role = 'super_admin';

    IF super_admin_count <= 1 THEN
      RAISE EXCEPTION 'At least one super administrator must remain';
    END IF;
  END IF;

  UPDATE public.college_profiles
    SET role = p_role
    WHERE id = p_user_id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    p_user_id,
    'role.assigned',
    pg_catalog.jsonb_build_object('previous_role', previous_role, 'new_role', p_role)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.stj_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stj_validate_exam_result() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stj_create_profile_for_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stj_has_role(public.stj_college_role[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stj_assign_college_role(uuid, public.stj_college_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stj_has_role(public.stj_college_role[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stj_assign_college_role(uuid, public.stj_college_role) TO authenticated;

ALTER TABLE public.college_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_programmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_course_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_examinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_fee_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_library_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_library_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY college_profiles_read
  ON public.college_profiles FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin']::public.stj_college_role[])
  );
CREATE POLICY college_profiles_update_self
  ON public.college_profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

CREATE POLICY college_departments_read
  ON public.college_departments FOR SELECT TO authenticated USING (true);
CREATE POLICY college_departments_insert
  ON public.college_departments FOR INSERT TO authenticated
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));
CREATE POLICY college_departments_update
  ON public.college_departments FOR UPDATE TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));
CREATE POLICY college_departments_delete
  ON public.college_departments FOR DELETE TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin']::public.stj_college_role[]));

CREATE POLICY college_programmes_read
  ON public.college_programmes FOR SELECT TO authenticated USING (true);
CREATE POLICY college_programmes_manage
  ON public.college_programmes FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_courses_read
  ON public.college_courses FOR SELECT TO authenticated USING (true);
CREATE POLICY college_courses_manage
  ON public.college_courses FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_staff_read
  ON public.college_staff FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
  );
CREATE POLICY college_staff_manage
  ON public.college_staff FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_students_read
  ON public.college_students FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
  );
CREATE POLICY college_students_manage
  ON public.college_students FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_course_offerings_read
  ON public.college_course_offerings FOR SELECT TO authenticated USING (true);
CREATE POLICY college_course_offerings_manage
  ON public.college_course_offerings FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_enrollments_read
  ON public.college_enrollments FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  );
CREATE POLICY college_enrollments_manage
  ON public.college_enrollments FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_attendance_sessions_read
  ON public.college_attendance_sessions FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM public.college_enrollments AS enrollment
      WHERE enrollment.course_offering_id = course_offering_id
        AND enrollment.student_id = (SELECT auth.uid())
        AND enrollment.enrollment_status = 'enrolled'
    )
  );
CREATE POLICY college_attendance_sessions_insert
  ON public.college_attendance_sessions FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (
      public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
      OR EXISTS (
        SELECT 1
        FROM public.college_course_offerings AS offering
        WHERE offering.id = course_offering_id
          AND offering.lecturer_id = (SELECT auth.uid())
      )
    )
  );
CREATE POLICY college_attendance_sessions_update
  ON public.college_attendance_sessions FOR UPDATE TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  );

CREATE POLICY college_attendance_records_read
  ON public.college_attendance_records FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_attendance_sessions AS session
      JOIN public.college_course_offerings AS offering
        ON offering.id = session.course_offering_id
      WHERE session.id = session_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  );
CREATE POLICY college_attendance_records_insert
  ON public.college_attendance_records FOR INSERT TO authenticated
  WITH CHECK (
    marked_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.college_attendance_sessions AS session
      JOIN public.college_course_offerings AS offering
        ON offering.id = session.course_offering_id
      JOIN public.college_enrollments AS enrollment
        ON enrollment.course_offering_id = offering.id
      WHERE session.id = session_id
        AND enrollment.student_id = student_id
        AND enrollment.enrollment_status = 'enrolled'
        AND (
          public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
          OR offering.lecturer_id = (SELECT auth.uid())
        )
    )
  );
CREATE POLICY college_attendance_records_update
  ON public.college_attendance_records FOR UPDATE TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_attendance_sessions AS session
      JOIN public.college_course_offerings AS offering
        ON offering.id = session.course_offering_id
      WHERE session.id = session_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    marked_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.college_attendance_sessions AS session
      JOIN public.college_course_offerings AS offering
        ON offering.id = session.course_offering_id
      JOIN public.college_enrollments AS enrollment
        ON enrollment.course_offering_id = offering.id
      WHERE session.id = session_id
        AND enrollment.student_id = student_id
        AND enrollment.enrollment_status = 'enrolled'
        AND (
          public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
          OR offering.lecturer_id = (SELECT auth.uid())
        )
    )
  );

CREATE POLICY college_examinations_read
  ON public.college_examinations FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM public.college_enrollments AS enrollment
      WHERE enrollment.course_offering_id = course_offering_id
        AND enrollment.student_id = (SELECT auth.uid())
        AND enrollment.enrollment_status = 'enrolled'
    )
  );
CREATE POLICY college_examinations_insert
  ON public.college_examinations FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (
      public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
      OR EXISTS (
        SELECT 1
        FROM public.college_course_offerings AS offering
        WHERE offering.id = course_offering_id
          AND offering.lecturer_id = (SELECT auth.uid())
      )
    )
  );
CREATE POLICY college_examinations_update
  ON public.college_examinations FOR UPDATE TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_course_offerings AS offering
      WHERE offering.id = course_offering_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  );

CREATE POLICY college_exam_results_read
  ON public.college_exam_results FOR SELECT TO authenticated
  USING (
    (student_id = (SELECT auth.uid()) AND published_at IS NOT NULL)
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_examinations AS examination
      JOIN public.college_course_offerings AS offering
        ON offering.id = examination.course_offering_id
      WHERE examination.id = examination_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  );
CREATE POLICY college_exam_results_insert
  ON public.college_exam_results FOR INSERT TO authenticated
  WITH CHECK (
    graded_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.college_examinations AS examination
      JOIN public.college_course_offerings AS offering
        ON offering.id = examination.course_offering_id
      JOIN public.college_enrollments AS enrollment
        ON enrollment.course_offering_id = offering.id
      WHERE examination.id = examination_id
        AND enrollment.student_id = student_id
        AND enrollment.enrollment_status = 'enrolled'
        AND (
          public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
          OR offering.lecturer_id = (SELECT auth.uid())
        )
    )
  );
CREATE POLICY college_exam_results_update
  ON public.college_exam_results FOR UPDATE TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
    OR EXISTS (
      SELECT 1
      FROM public.college_examinations AS examination
      JOIN public.college_course_offerings AS offering
        ON offering.id = examination.course_offering_id
      WHERE examination.id = examination_id
        AND offering.lecturer_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    graded_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.college_examinations AS examination
      JOIN public.college_course_offerings AS offering
        ON offering.id = examination.course_offering_id
      JOIN public.college_enrollments AS enrollment
        ON enrollment.course_offering_id = offering.id
      WHERE examination.id = examination_id
        AND enrollment.student_id = student_id
        AND enrollment.enrollment_status = 'enrolled'
        AND (
          public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']::public.stj_college_role[])
          OR offering.lecturer_id = (SELECT auth.uid())
        )
    )
  );

CREATE POLICY college_fee_charges_read
  ON public.college_fee_charges FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'finance_accountant', 'bursar']::public.stj_college_role[])
  );
CREATE POLICY college_fee_charges_manage
  ON public.college_fee_charges FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'finance_accountant', 'bursar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'finance_accountant', 'bursar']::public.stj_college_role[]));

CREATE POLICY college_payments_read
  ON public.college_payments FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'finance_accountant', 'bursar']::public.stj_college_role[])
  );

CREATE POLICY college_library_books_read
  ON public.college_library_books FOR SELECT TO authenticated USING (true);
CREATE POLICY college_library_books_manage
  ON public.college_library_books FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]));

CREATE POLICY college_library_loans_read
  ON public.college_library_loans FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR public.stj_has_role(ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[])
  );
CREATE POLICY college_library_loans_manage
  ON public.college_library_loans FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]));

CREATE POLICY college_timetable_slots_read
  ON public.college_timetable_slots FOR SELECT TO authenticated USING (true);
CREATE POLICY college_timetable_slots_manage
  ON public.college_timetable_slots FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

CREATE POLICY college_audit_events_read
  ON public.college_audit_events FOR SELECT TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin']::public.stj_college_role[]));

REVOKE ALL ON TABLE
  public.college_profiles,
  public.college_departments,
  public.college_programmes,
  public.college_courses,
  public.college_staff,
  public.college_students,
  public.college_course_offerings,
  public.college_enrollments,
  public.college_attendance_sessions,
  public.college_attendance_records,
  public.college_examinations,
  public.college_exam_results,
  public.college_fee_charges,
  public.college_payments,
  public.college_library_books,
  public.college_library_loans,
  public.college_timetable_slots,
  public.college_audit_events
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TYPE public.stj_college_role FROM PUBLIC, anon, authenticated;
GRANT USAGE ON TYPE public.stj_college_role TO authenticated;
GRANT SELECT ON public.college_profiles TO authenticated;
GRANT UPDATE (full_name, phone) ON public.college_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON
  public.college_departments,
  public.college_programmes,
  public.college_courses,
  public.college_staff,
  public.college_students,
  public.college_course_offerings,
  public.college_enrollments,
  public.college_library_books,
  public.college_library_loans,
  public.college_timetable_slots
TO authenticated;
GRANT SELECT, INSERT ON
  public.college_attendance_sessions,
  public.college_attendance_records,
  public.college_examinations,
  public.college_exam_results
TO authenticated;
GRANT UPDATE (course_offering_id, starts_at, ends_at, session_status, qr_token_hash, qr_expires_at)
  ON public.college_attendance_sessions TO authenticated;
GRANT UPDATE (attendance_status, marked_by)
  ON public.college_attendance_records TO authenticated;
GRANT UPDATE (course_offering_id, title, scheduled_at, max_score, exam_status)
  ON public.college_examinations TO authenticated;
GRANT UPDATE (score, graded_by, graded_at, published_at)
  ON public.college_exam_results TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.college_fee_charges TO authenticated;
GRANT SELECT ON
  public.college_payments,
  public.college_audit_events
TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
