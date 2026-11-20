DO $bootstrap$
DECLARE
  bootstrap_user_id uuid;
  bootstrap_email text;
  changed_user_id uuid;
BEGIN
  SELECT auth_user.id, auth_user.email
    INTO bootstrap_user_id, bootstrap_email
    FROM auth.users AS auth_user
    WHERE lower(auth_user.email) = lower('mrjemoh18@gmail.com')
      AND auth_user.email_confirmed_at IS NOT NULL;

  IF bootstrap_user_id IS NULL THEN
    RAISE EXCEPTION
      'Create and verify the designated account in Supabase Auth before running this bootstrap';
  END IF;

  INSERT INTO public.college_profiles (id, email, role)
  VALUES (
    bootstrap_user_id,
    bootstrap_email,
    'super_admin'::public.stj_college_role
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        role = 'super_admin'::public.stj_college_role,
        updated_at = pg_catalog.now()
    WHERE public.college_profiles.email IS DISTINCT FROM EXCLUDED.email
       OR public.college_profiles.role IS DISTINCT FROM EXCLUDED.role
  RETURNING id INTO changed_user_id;

  IF changed_user_id IS NOT NULL THEN
    INSERT INTO public.college_audit_events (actor_id, target_user_id, action, details)
    VALUES (
      NULL,
      bootstrap_user_id,
      'role.bootstrap_super_admin',
      '{}'::jsonb
    );
  END IF;
END;
$bootstrap$;
