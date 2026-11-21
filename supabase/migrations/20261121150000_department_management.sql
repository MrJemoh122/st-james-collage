BEGIN;

GRANT DELETE ON TABLE public.college_departments TO authenticated;

ALTER TABLE public.college_profiles
  ADD COLUMN is_suspended boolean NOT NULL DEFAULT false;
DROP POLICY IF EXISTS college_profiles_update_self ON public.college_profiles;
REVOKE UPDATE ON TABLE public.college_profiles FROM authenticated;

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
        AND NOT profile.is_suspended
  )
$$;

CREATE TABLE public.college_account_deletion_jobs (
  target_user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  storage_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.college_account_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.college_account_deletion_jobs FROM PUBLIC, anon, authenticated;

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
    RAISE EXCEPTION 'A super administrator cannot assign themselves as department head'
      USING ERRCODE = '42501';
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
    SELECT 1
      FROM public.college_departments AS department
      WHERE department.id = p_department_id AND department.is_active
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

  IF p_role = 'department_head' THEN
    RAISE EXCEPTION 'Use the department-head assignment workflow to set this role';
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
    IF NOT EXISTS (
      SELECT 1
        FROM public.college_profiles AS profile
        WHERE profile.id <> p_user_id
          AND profile.role = 'super_admin'
          AND NOT profile.is_suspended
    ) THEN
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

CREATE OR REPLACE FUNCTION public.stj_set_college_account_suspension(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_is_suspended boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_role public.stj_college_role;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.college_profiles AS actor
      WHERE actor.id = p_actor_id AND actor.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'Only a super administrator can suspend or restore accounts'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_id = p_target_user_id THEN
    RAISE EXCEPTION 'A super administrator cannot suspend their own account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 1);

  SELECT profile.role
    INTO target_role
    FROM public.college_profiles AS profile
    WHERE profile.id = p_target_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target account was not found';
  END IF;

  IF p_is_suspended AND target_role = 'super_admin'
     AND NOT EXISTS (
       SELECT 1
         FROM public.college_profiles AS profile
         WHERE profile.role = 'super_admin'
           AND profile.id <> p_target_user_id
           AND NOT profile.is_suspended
     ) THEN
    RAISE EXCEPTION 'At least one active super administrator must remain'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.college_profiles
    SET is_suspended = p_is_suspended
    WHERE id = p_target_user_id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    p_actor_id,
    p_target_user_id,
    CASE WHEN p_is_suspended THEN 'account.suspended' ELSE 'account.restored' END,
    '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.stj_prepare_college_account_deletion(
  p_actor_id uuid,
  p_target_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_role public.stj_college_role;
  file_paths jsonb;
  has_existing_job boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.college_profiles AS actor
      WHERE actor.id = p_actor_id AND actor.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'Only a super administrator can delete accounts'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_id = p_target_user_id THEN
    RAISE EXCEPTION 'A super administrator cannot delete their own account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 1);

  SELECT profile.role
    INTO target_role
    FROM public.college_profiles AS profile
    WHERE profile.id = p_target_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target account was not found';
  END IF;

  IF target_role = 'super_admin'
     AND NOT EXISTS (
       SELECT 1
         FROM public.college_profiles AS profile
         WHERE profile.role = 'super_admin'
           AND profile.id <> p_target_user_id
           AND NOT profile.is_suspended
     ) THEN
    RAISE EXCEPTION 'At least one active super administrator must remain'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.college_account_deletion_jobs AS job
      WHERE job.target_user_id = p_target_user_id
  )
    INTO has_existing_job;

  IF has_existing_job THEN
    SELECT job.storage_paths
      INTO file_paths
      FROM public.college_account_deletion_jobs AS job
      WHERE job.target_user_id = p_target_user_id;
  ELSE
    SELECT COALESCE(pg_catalog.jsonb_agg(path), '[]'::jsonb)
      INTO file_paths
      FROM (
        SELECT student.photo_path AS path
          FROM public.college_students AS student
          WHERE student.id = p_target_user_id
        UNION
        SELECT staff.photo_path
          FROM public.college_staff AS staff
          WHERE staff.id = p_target_user_id
        UNION
        SELECT application.photo_path
          FROM public.college_student_applications AS application
          WHERE application.user_id = p_target_user_id
        UNION
        SELECT document.storage_path
          FROM public.college_student_application_documents AS document
          JOIN public.college_student_applications AS application
            ON application.id = document.application_id
          WHERE application.user_id = p_target_user_id
        UNION
        SELECT application.photo_path
          FROM public.college_staff_applications AS application
          WHERE application.user_id = p_target_user_id
        UNION
        SELECT document.storage_path
          FROM public.college_staff_application_documents AS document
          JOIN public.college_staff_applications AS application
            ON application.id = document.application_id
          WHERE application.user_id = p_target_user_id
      ) AS account_files
      WHERE path IS NOT NULL AND pg_catalog.btrim(path) <> '';
  END IF;

  UPDATE public.college_profiles
    SET is_suspended = true, role = 'pending'
    WHERE id = p_target_user_id;

  UPDATE public.college_course_offerings
    SET lecturer_id = NULL
    WHERE lecturer_id = p_target_user_id;
  UPDATE public.college_attendance_sessions
    SET created_by = p_actor_id
    WHERE created_by = p_target_user_id;
  UPDATE public.college_attendance_records
    SET marked_by = NULL
    WHERE marked_by = p_target_user_id;
  UPDATE public.college_examinations
    SET created_by = p_actor_id
    WHERE created_by = p_target_user_id;
  UPDATE public.college_exam_results
    SET graded_by = p_actor_id
    WHERE graded_by = p_target_user_id
      AND student_id <> p_target_user_id;
  UPDATE public.college_fee_charges
    SET created_by = NULL
    WHERE created_by = p_target_user_id;
  UPDATE public.college_library_loans
    SET issued_by = p_actor_id
    WHERE issued_by = p_target_user_id
      AND student_id <> p_target_user_id;
  UPDATE public.college_student_applications
    SET reviewed_by = NULL
    WHERE reviewed_by = p_target_user_id;
  UPDATE public.college_staff_applications
    SET reviewed_by = NULL
    WHERE reviewed_by = p_target_user_id;
  UPDATE public.college_student_programme_history
    SET changed_by = NULL
    WHERE changed_by = p_target_user_id;
  UPDATE public.college_programme_year_offerings
    SET created_by = NULL
    WHERE created_by = p_target_user_id;
  UPDATE public.college_attendance_qr_tokens
    SET created_by = p_actor_id
    WHERE created_by = p_target_user_id;

  UPDATE public.college_library_books AS book
    SET available_copies = LEAST(
      book.total_copies,
      book.available_copies + outstanding.copies
    )
    FROM (
      SELECT loan.book_id, pg_catalog.count(*)::integer AS copies
        FROM public.college_library_loans AS loan
        WHERE loan.student_id = p_target_user_id
          AND loan.returned_at IS NULL
        GROUP BY loan.book_id
    ) AS outstanding
    WHERE book.id = outstanding.book_id;

  DELETE FROM public.college_attendance_records
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_exam_results
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_library_loans
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_payments
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_fee_charges
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_student_programme_history
    WHERE student_id = p_target_user_id;
  DELETE FROM public.college_enrollments
    WHERE student_id = p_target_user_id;

  UPDATE public.college_students
    SET application_id = NULL
    WHERE id = p_target_user_id;
  UPDATE public.college_staff
    SET application_id = NULL
    WHERE id = p_target_user_id;
  DELETE FROM public.college_student_applications
    WHERE user_id = p_target_user_id;
  DELETE FROM public.college_staff_applications
    WHERE user_id = p_target_user_id;
  DELETE FROM public.college_students
    WHERE id = p_target_user_id;
  DELETE FROM public.college_staff
    WHERE id = p_target_user_id;

  INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
  VALUES (
    p_actor_id,
    p_target_user_id,
    'account.deletion_prepared',
    pg_catalog.jsonb_build_object(
      'previous_role', target_role,
      'target_user_id', p_target_user_id
    )
  );

  INSERT INTO public.college_account_deletion_jobs (target_user_id, storage_paths)
  VALUES (p_target_user_id, file_paths)
  ON CONFLICT (target_user_id) DO UPDATE
    SET storage_paths = EXCLUDED.storage_paths;

  RETURN file_paths;
END;
$$;

REVOKE ALL ON FUNCTION public.stj_set_college_account_suspension(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stj_set_college_account_suspension(uuid, uuid, boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.stj_prepare_college_account_deletion(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stj_prepare_college_account_deletion(uuid, uuid)
  TO service_role;

COMMIT;
