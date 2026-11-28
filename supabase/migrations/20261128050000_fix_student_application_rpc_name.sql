BEGIN;

-- PostgreSQL truncates identifiers longer than 63 bytes, so the earlier RPC name was stored without its final characters.
DO $$
DECLARE
  truncated_function regprocedure := to_regprocedure(
    'public.submit_college_student_application_with_qualification_preferenc(uuid,text,text,date,text,text,text,text,text,jsonb,uuid[])'
  );
  corrected_function regprocedure := to_regprocedure(
    'public.submit_college_student_application_with_qualification_prefs(uuid,text,text,date,text,text,text,text,text,jsonb,uuid[])'
  );
BEGIN
  IF truncated_function IS NOT NULL AND corrected_function IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.submit_college_student_application_with_qualification_preferenc(uuid, text, text, date, text, text, text, text, text, jsonb, uuid[]) RENAME TO submit_college_student_application_with_qualification_prefs';
  ELSIF truncated_function IS NOT NULL AND corrected_function IS NOT NULL THEN
    RAISE EXCEPTION 'Both truncated and corrected student-application RPC functions exist; resolve the duplicate before applying this migration';
  ELSIF corrected_function IS NULL THEN
    RAISE EXCEPTION 'Student-application RPC function was not found under the expected truncated or corrected name';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
