BEGIN;

DROP POLICY IF EXISTS college_course_study_years_manage
  ON public.college_course_study_years;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.college_course_study_years
  FROM authenticated;
GRANT SELECT ON TABLE public.college_course_study_years
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
