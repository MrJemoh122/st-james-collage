BEGIN;

CREATE TABLE IF NOT EXISTS public.college_student_number_sequences (
  course_code text NOT NULL CHECK (course_code ~ '^[A-Z0-9]{2,12}$'),
  admission_year smallint NOT NULL CHECK (admission_year BETWEEN 2000 AND 9999),
  last_issued integer NOT NULL CHECK (last_issued BETWEEN 1 AND 9999),
  PRIMARY KEY (course_code, admission_year)
);

REVOKE ALL ON TABLE public.college_student_number_sequences
  FROM PUBLIC, anon, authenticated;

WITH parsed_numbers AS (
  SELECT pg_catalog.regexp_match(
    student.student_number,
    '^STJIT/([A-Z0-9]{2,12})/([0-9]{4})/([0-9]{4})$'
  ) AS parts
  FROM public.college_students AS student
), valid_numbers AS (
  SELECT
    parts[1] AS course_code,
    parts[3]::smallint AS admission_year,
    parts[2]::integer AS student_number
  FROM parsed_numbers
  WHERE parts IS NOT NULL
)
INSERT INTO public.college_student_number_sequences (
  course_code, admission_year, last_issued
)
SELECT course_code, admission_year, pg_catalog.max(student_number)
FROM valid_numbers
WHERE student_number BETWEEN 1 AND 9999
  AND admission_year BETWEEN 2000 AND 9999
GROUP BY course_code, admission_year
ON CONFLICT (course_code, admission_year)
DO UPDATE SET last_issued = CASE
  WHEN public.college_student_number_sequences.last_issued > EXCLUDED.last_issued
    THEN public.college_student_number_sequences.last_issued
  ELSE EXCLUDED.last_issued
END;

COMMIT;

NOTIFY pgrst, 'reload schema';
