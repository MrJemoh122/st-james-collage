BEGIN;

CREATE TABLE IF NOT EXISTS public.college_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.college_departments (id),
  course_id uuid REFERENCES public.college_courses (id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  credit_hours smallint NOT NULL DEFAULT 1 CHECK (credit_hours > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

CREATE TABLE IF NOT EXISTS public.college_subject_cores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES public.college_subjects (id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  learning_outcomes text[] NOT NULL DEFAULT ARRAY[]::text[],
  sort_order integer NOT NULL CHECK (sort_order > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, sort_order)
);

CREATE TABLE IF NOT EXISTS public.college_lecturer_subject_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lecturer_id uuid NOT NULL REFERENCES public.college_staff (id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES public.college_subjects (id) ON DELETE CASCADE,
  course_offering_id uuid NOT NULL REFERENCES public.college_course_offerings (id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES public.college_profiles (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (lecturer_id, subject_id, course_offering_id)
);

CREATE TABLE IF NOT EXISTS public.college_department_head_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.college_departments (id),
  lecturer_id uuid NOT NULL REFERENCES public.college_staff (id),
  appointed_by uuid NOT NULL REFERENCES public.college_profiles (id),
  appointed_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (NOT is_active OR ended_at IS NULL),
  UNIQUE (department_id, lecturer_id, appointed_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS college_one_active_department_head_idx
  ON public.college_department_head_appointments (department_id)
  WHERE is_active;

ALTER TABLE public.college_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_subject_cores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_lecturer_subject_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_department_head_appointments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.stj_staff_department_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT staff.department_id
  FROM public.college_staff AS staff
  WHERE staff.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.stj_staff_department_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stj_staff_department_id(uuid) TO authenticated;

CREATE POLICY college_courses_manage_department_head
  ON public.college_courses FOR ALL TO authenticated
  USING (
    public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
    AND department_id = public.stj_staff_department_id(auth.uid())
  )
  WITH CHECK (
    public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
    AND department_id = public.stj_staff_department_id(auth.uid())
  );

CREATE POLICY college_subjects_read
  ON public.college_subjects FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY[
      'super_admin', 'college_admin', 'academic_registrar', 'department_head',
      'lecturer', 'student', 'examination_officer'
    ]::public.stj_college_role[])
  );

CREATE POLICY college_subjects_manage
  ON public.college_subjects FOR ALL TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND department_id = public.stj_staff_department_id(auth.uid())
    )
  )
  WITH CHECK (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND department_id = public.stj_staff_department_id(auth.uid())
    )
  );

CREATE POLICY college_subject_cores_read
  ON public.college_subject_cores FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.college_subjects AS subject
    WHERE subject.id = college_subject_cores.subject_id
  ));

CREATE POLICY college_subject_cores_manage
  ON public.college_subject_cores FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.college_subjects AS subject
    WHERE subject.id = college_subject_cores.subject_id
      AND (
        public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
        OR (
          public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
          AND subject.department_id = public.stj_staff_department_id(auth.uid())
        )
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.college_subjects AS subject
    WHERE subject.id = college_subject_cores.subject_id
      AND (
        public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
        OR (
          public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
          AND subject.department_id = public.stj_staff_department_id(auth.uid())
        )
      )
  ));

CREATE POLICY college_lecturer_assignments_read
  ON public.college_lecturer_subject_assignments FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar', 'department_head', 'examination_officer']::public.stj_college_role[])
    OR lecturer_id = auth.uid()
  );

CREATE POLICY college_lecturer_assignments_manage
  ON public.college_lecturer_subject_assignments FOR ALL TO authenticated
  USING (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND EXISTS (
        SELECT 1
        FROM public.college_subjects AS subject
        WHERE subject.id = college_lecturer_subject_assignments.subject_id
          AND subject.department_id = public.stj_staff_department_id(auth.uid())
      )
    )
  )
  WITH CHECK (
    public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[])
    OR (
      public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
      AND assigned_by = auth.uid()
      AND EXISTS (
        SELECT 1
        FROM public.college_subjects AS subject
        JOIN public.college_course_offerings AS offering ON offering.id = college_lecturer_subject_assignments.course_offering_id
        JOIN public.college_courses AS course ON course.id = offering.course_id
        WHERE subject.id = college_lecturer_subject_assignments.subject_id
          AND subject.department_id = public.stj_staff_department_id(auth.uid())
          AND course.department_id = subject.department_id
      )
    )
  );

CREATE POLICY college_department_head_appointments_read
  ON public.college_department_head_appointments FOR SELECT TO authenticated
  USING (public.stj_has_role(ARRAY[
    'super_admin', 'college_admin', 'academic_registrar', 'department_head'
  ]::public.stj_college_role[]) );

CREATE POLICY college_department_head_appointments_manage
  ON public.college_department_head_appointments FOR ALL TO authenticated
  USING (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]))
  WITH CHECK (public.stj_has_role(ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]));

REVOKE ALL ON TABLE
  public.college_subjects,
  public.college_subject_cores,
  public.college_lecturer_subject_assignments,
  public.college_department_head_appointments
  FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE ON
  public.college_subjects,
  public.college_subject_cores,
  public.college_lecturer_subject_assignments,
  public.college_department_head_appointments
  TO authenticated;

GRANT DELETE ON
  public.college_subject_cores,
  public.college_lecturer_subject_assignments
  TO authenticated;

CREATE POLICY college_staff_read_department_head
  ON public.college_staff FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
    AND department_id = public.stj_staff_department_id(auth.uid())
  );

CREATE POLICY college_profiles_read_department_head
  ON public.college_profiles FOR SELECT TO authenticated
  USING (
    public.stj_has_role(ARRAY['department_head']::public.stj_college_role[])
    AND EXISTS (
      SELECT 1
      FROM public.college_staff AS staff
      WHERE staff.id = college_profiles.id
        AND staff.department_id = public.stj_staff_department_id(auth.uid())
    )
  );

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
  actor_role public.stj_college_role;
  actor_department_id uuid;
BEGIN
  SELECT profile.role
    INTO actor_role
    FROM public.college_profiles AS profile
    WHERE profile.id = p_actor_id;

  IF actor_role IN ('super_admin', 'college_admin', 'academic_registrar') THEN
    NULL;
  ELSE
    IF actor_role <> 'department_head' THEN
      RAISE EXCEPTION 'You are not allowed to create staff accounts'
        USING ERRCODE = '42501';
    END IF;
    SELECT staff.department_id
      INTO actor_department_id
      FROM public.college_staff AS staff
      WHERE staff.id = p_actor_id;
    IF actor_department_id IS NULL OR actor_department_id <> p_department_id THEN
      RAISE EXCEPTION 'A department head can only add staff to their authorized department'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_staff_type <> 'lecturer'
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
        role = 'lecturer'::public.stj_college_role
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
      'staff_type', 'lecturer',
      'department_id', p_department_id,
      'created_by_department_head', actor_role = 'department_head'
    )
  );

  RETURN assigned_number;
END;
$$;

REVOKE ALL ON FUNCTION public.create_college_staff_account(uuid, uuid, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_college_staff_account(uuid, uuid, text, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.stj_assign_department_head(
  p_user_id uuid,
  p_department_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  previous_role public.stj_college_role;
  previous_department_id uuid;
  target_is_suspended boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(ARRAY['super_admin']::public.stj_college_role[]) THEN
    RAISE EXCEPTION 'Only a super administrator can assign department heads'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = actor_id THEN
    RAISE EXCEPTION 'A super administrator cannot assign themselves as department head';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 1);

  SELECT profile.role, profile.is_suspended
    INTO previous_role, target_is_suspended
    FROM public.college_profiles AS profile
    WHERE profile.id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target account has no college profile';
  END IF;
  IF target_is_suspended THEN
    RAISE EXCEPTION 'Restore the staff account before assigning it as department head';
  END IF;
  IF previous_role NOT IN ('lecturer', 'non_teaching_staff', 'department_head') THEN
    RAISE EXCEPTION 'Only an existing staff member can be assigned as department head';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.college_departments
    WHERE id = p_department_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Select an active department';
  END IF;

  SELECT staff.department_id
    INTO previous_department_id
    FROM public.college_staff AS staff
    WHERE staff.id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target account does not have a staff record';
  END IF;

  UPDATE public.college_department_head_appointments
    SET is_active = false,
        ended_at = now()
    WHERE department_id = p_department_id
      AND is_active;

  INSERT INTO public.college_department_head_appointments (
    department_id, lecturer_id, appointed_by
  )
  VALUES (p_department_id, p_user_id, actor_id);

  UPDATE public.college_staff
    SET department_id = p_department_id
    WHERE id = p_user_id;

  UPDATE public.college_profiles
    SET role = 'department_head'
    WHERE id = p_user_id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    actor_id,
    p_user_id,
    'department_head.assigned',
    pg_catalog.jsonb_build_object(
      'previous_role', previous_role,
      'department_id', p_department_id,
      'previous_department_id', previous_department_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.stj_assign_department_head(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stj_assign_department_head(uuid, uuid) TO authenticated;

COMMIT;
