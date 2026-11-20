BEGIN;

ALTER TABLE public.college_timetable_slots
  ADD COLUMN IF NOT EXISTS slot_status text NOT NULL DEFAULT 'scheduled';

DO $timetable_status_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'college_timetable_slots_status_check'
      AND conrelid = 'public.college_timetable_slots'::regclass
  ) THEN
    ALTER TABLE public.college_timetable_slots
      ADD CONSTRAINT college_timetable_slots_status_check
      CHECK (slot_status IN ('scheduled', 'cancelled'));
  END IF;
END;
$timetable_status_constraint$;

DROP POLICY IF EXISTS college_timetable_slots_read
  ON public.college_timetable_slots;
CREATE POLICY college_timetable_slots_read
  ON public.college_timetable_slots FOR SELECT TO authenticated
  USING (
    public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
    )
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

CREATE OR REPLACE FUNCTION public.stj_check_college_timetable_conflict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  selected_offering public.college_course_offerings%ROWTYPE;
BEGIN
  IF NEW.slot_status <> 'scheduled' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 2);

  SELECT offering.*
    INTO selected_offering
    FROM public.college_course_offerings AS offering
    WHERE offering.id = NEW.course_offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected course offering does not exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.college_timetable_slots AS existing_slot
    JOIN public.college_course_offerings AS existing_offering
      ON existing_offering.id = existing_slot.course_offering_id
    WHERE existing_slot.id IS DISTINCT FROM NEW.id
      AND existing_slot.slot_status = 'scheduled'
      AND existing_slot.day_of_week = NEW.day_of_week
      AND existing_offering.academic_year = selected_offering.academic_year
      AND existing_offering.term = selected_offering.term
      AND NEW.starts_at < existing_slot.ends_at
      AND NEW.ends_at > existing_slot.starts_at
      AND (
        existing_slot.course_offering_id = NEW.course_offering_id
        OR (
          selected_offering.lecturer_id IS NOT NULL
          AND existing_offering.lecturer_id = selected_offering.lecturer_id
        )
        OR (
          NULLIF(pg_catalog.btrim(NEW.room), '') IS NOT NULL
          AND pg_catalog.lower(pg_catalog.btrim(existing_slot.room))
            = pg_catalog.lower(pg_catalog.btrim(NEW.room))
        )
      )
  ) THEN
    RAISE EXCEPTION 'The timetable entry conflicts with an existing class, lecturer, or room booking'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS college_timetable_slots_conflict
  ON public.college_timetable_slots;
CREATE TRIGGER college_timetable_slots_conflict
  BEFORE INSERT OR UPDATE OF course_offering_id, day_of_week, starts_at, ends_at, room
  ON public.college_timetable_slots
  FOR EACH ROW EXECUTE FUNCTION public.stj_check_college_timetable_conflict();

CREATE OR REPLACE FUNCTION public.stj_adjust_college_library_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.college_library_books
      SET available_copies = available_copies - 1
      WHERE id = NEW.book_id
        AND available_copies > 0;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No available copy exists for the selected book';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.book_id IS DISTINCT FROM OLD.book_id THEN
    RAISE EXCEPTION 'A loan cannot be reassigned to a different book';
  END IF;

  IF OLD.returned_at IS NOT NULL
     AND NEW.returned_at IS DISTINCT FROM OLD.returned_at THEN
    RAISE EXCEPTION 'A completed return cannot be changed';
  END IF;

  IF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
    UPDATE public.college_library_books
      SET available_copies = available_copies + 1
      WHERE id = NEW.book_id
        AND available_copies < total_copies;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Book inventory is inconsistent; reconcile copies before recording the return';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS college_library_loans_adjust_inventory
  ON public.college_library_loans;
CREATE TRIGGER college_library_loans_adjust_inventory
  BEFORE INSERT OR UPDATE OF book_id, returned_at
  ON public.college_library_loans
  FOR EACH ROW EXECUTE FUNCTION public.stj_adjust_college_library_inventory();

CREATE OR REPLACE FUNCTION public.issue_college_library_loan(
  p_book_id uuid,
  p_student_id uuid,
  p_due_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  loan_id uuid;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'Only authorized library staff can issue books'
      USING ERRCODE = '42501';
  END IF;

  IF p_due_at IS NULL OR p_due_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'The due date must be in the future';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_students AS student
    JOIN public.college_profiles AS profile ON profile.id = student.id
    WHERE student.id = p_student_id
      AND student.student_status = 'active'
      AND profile.role = 'student'
  ) THEN
    RAISE EXCEPTION 'The selected account is not an active student'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.college_library_loans (
    book_id, student_id, issued_by, due_at
  )
  VALUES (p_book_id, p_student_id, actor_id, p_due_at)
  RETURNING id INTO loan_id;

  RETURN loan_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.return_college_library_loan(p_loan_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'Only authorized library staff can record returns'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.college_library_loans
    SET returned_at = pg_catalog.clock_timestamp()
    WHERE id = p_loan_id
      AND returned_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The loan was not found or was already returned';
  END IF;
END;
$$;

DROP POLICY IF EXISTS college_library_loans_manage
  ON public.college_library_loans;
CREATE POLICY college_library_loans_manage
  ON public.college_library_loans FOR ALL TO authenticated
  USING (public.stj_has_role(
    ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]
  ))
  WITH CHECK (
    issued_by = (SELECT auth.uid())
    AND public.stj_has_role(
      ARRAY['super_admin', 'college_admin', 'librarian']::public.stj_college_role[]
    )
  );

REVOKE INSERT, UPDATE ON public.college_library_loans
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.issue_college_library_loan(uuid, uuid, timestamptz)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_college_library_loan(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_college_library_loan(uuid, uuid, timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_college_library_loan(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.stj_check_college_timetable_conflict()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stj_adjust_college_library_inventory()
  FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
