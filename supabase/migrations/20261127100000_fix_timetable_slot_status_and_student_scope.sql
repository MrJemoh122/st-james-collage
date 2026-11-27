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

GRANT SELECT ON TABLE public.college_timetable_slots TO authenticated;

COMMIT;
