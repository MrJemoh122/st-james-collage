BEGIN;

GRANT DELETE ON TABLE public.college_courses TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
