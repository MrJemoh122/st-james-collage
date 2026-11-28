BEGIN;

CREATE OR REPLACE FUNCTION public.generate_department_timetable(
  p_department_id uuid,
  p_academic_year text,
  p_term smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  active_offering_count bigint;
  slots_created bigint := 0;
  enrollments_created bigint := 0;
  offering_row record;
  candidate_day integer;
  candidate_start time;
  candidate_room text;
  class_duration interval;
  slot_placed boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT public.stj_has_role(
       ARRAY['super_admin', 'college_admin', 'academic_registrar']::public.stj_college_role[]
     ) THEN
    RAISE EXCEPTION 'Only authorized academic staff can generate department timetables'
      USING ERRCODE = '42501';
  END IF;

  IF p_department_id IS NULL
     OR NULLIF(pg_catalog.btrim(p_academic_year), '') IS NULL
     OR p_term IS NULL
     OR p_term < 1 THEN
    RAISE EXCEPTION 'Choose a department, academic year, and valid term'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.college_departments AS department
    WHERE department.id = p_department_id
      AND department.is_active
  ) THEN
    RAISE EXCEPTION 'The selected department does not exist or is inactive';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(7412, 2);

  SELECT pg_catalog.count(*)
    INTO active_offering_count
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term;

  IF active_offering_count = 0 THEN
    RAISE EXCEPTION 'No active course offerings were found for the selected department, academic year, and term';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND course.credit_hours NOT IN (1, 2)
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_timetable_slots AS existing_slot
        WHERE existing_slot.course_offering_id = offering.id
          AND existing_slot.slot_status = 'scheduled'
      )
  ) THEN
    RAISE EXCEPTION 'Automatic scheduling requires every unscheduled subject in this term to have 1 or 2 credit hours';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_course_study_years AS course_year
        WHERE course_year.course_id = course.id
      )
  ) THEN
    RAISE EXCEPTION 'Assign at least one study year to every active subject in this term before generating the timetable and enrolling students';
  END IF;

  FOR offering_row IN
    SELECT offering.id, offering.lecturer_id, course.credit_hours
    FROM public.college_course_offerings AS offering
    JOIN public.college_courses AS course
      ON course.id = offering.course_id
    WHERE course.department_id = p_department_id
      AND course.is_active
      AND offering.academic_year = pg_catalog.btrim(p_academic_year)
      AND offering.term = p_term
      AND NOT EXISTS (
        SELECT 1
        FROM public.college_timetable_slots AS existing_slot
        WHERE existing_slot.course_offering_id = offering.id
          AND existing_slot.slot_status = 'scheduled'
      )
    ORDER BY course.code, offering.section, offering.id
  LOOP
    class_duration := offering_row.credit_hours * INTERVAL '1 hour';
    slot_placed := false;

    FOR candidate_day IN 1..5 LOOP
      candidate_start := TIME '08:00';

      WHILE candidate_start + class_duration <= TIME '17:00' LOOP
        FOR candidate_room IN
          SELECT available_room.room
          FROM (
            SELECT 1 AS room_type, rooms.room_number,
              'Lecture Room ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 15) AS rooms(room_number)
            UNION ALL
            SELECT 2 AS room_type, rooms.room_number,
              'Seminar Room ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 10) AS rooms(room_number)
            UNION ALL
            SELECT 3 AS room_type, rooms.room_number,
              'Lecture Theater ' || rooms.room_number::text AS room
            FROM pg_catalog.generate_series(1, 8) AS rooms(room_number)
          ) AS available_room
          ORDER BY available_room.room_type, available_room.room_number
        LOOP
          IF NOT EXISTS (
            SELECT 1
            FROM public.college_timetable_slots AS existing_slot
            JOIN public.college_course_offerings AS existing_offering
              ON existing_offering.id = existing_slot.course_offering_id
            WHERE existing_slot.slot_status = 'scheduled'
              AND existing_slot.day_of_week = candidate_day
              AND existing_offering.academic_year = pg_catalog.btrim(p_academic_year)
              AND existing_offering.term = p_term
              AND candidate_start < existing_slot.ends_at
              AND candidate_start + class_duration > existing_slot.starts_at
              AND (
                existing_slot.course_offering_id = offering_row.id
                OR (
                  offering_row.lecturer_id IS NOT NULL
                  AND existing_offering.lecturer_id = offering_row.lecturer_id
                )
                OR pg_catalog.lower(pg_catalog.btrim(existing_slot.room))
                  = pg_catalog.lower(pg_catalog.btrim(candidate_room))
              )
          ) THEN
            INSERT INTO public.college_timetable_slots (
              course_offering_id,
              day_of_week,
              starts_at,
              ends_at,
              room
            )
            VALUES (
              offering_row.id,
              candidate_day,
              candidate_start,
              candidate_start + class_duration,
              candidate_room
            );

            slots_created := slots_created + 1;
            slot_placed := true;
            EXIT;
          END IF;
        END LOOP;

        EXIT WHEN slot_placed;
        candidate_start := candidate_start + INTERVAL '1 hour';
      END LOOP;

      EXIT WHEN slot_placed;
    END LOOP;

    IF NOT slot_placed THEN
      RAISE EXCEPTION 'No conflict-free timetable slot could be found for course offering %. No timetable or enrollment changes were saved.',
        offering_row.id
        USING ERRCODE = '23P01';
    END IF;
  END LOOP;

  INSERT INTO public.college_enrollments (
    student_id,
    course_offering_id,
    enrollment_status
  )
  SELECT student.id, offering.id, 'enrolled'
  FROM public.college_course_offerings AS offering
  JOIN public.college_courses AS course
    ON course.id = offering.course_id
  JOIN public.college_course_study_years AS course_year
    ON course_year.course_id = course.id
  JOIN public.college_students AS student
    ON student.department_id = course.department_id
   AND student.study_year = course_year.study_year
  JOIN public.college_profiles AS profile
    ON profile.id = student.id
  WHERE course.department_id = p_department_id
    AND course.is_active
    AND offering.academic_year = pg_catalog.btrim(p_academic_year)
    AND offering.term = p_term
    AND student.student_status = 'active'
    AND profile.role = 'student'
  ON CONFLICT (student_id, course_offering_id) DO NOTHING;

  GET DIAGNOSTICS enrollments_created = ROW_COUNT;

  INSERT INTO public.college_audit_events (actor_id, action, details)
  VALUES (
    actor_id,
    'timetable.department_generated',
    pg_catalog.jsonb_build_object(
      'department_id', p_department_id,
      'academic_year', pg_catalog.btrim(p_academic_year),
      'term', p_term,
      'slots_created', slots_created,
      'enrollments_created', enrollments_created
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'slots_created', slots_created,
    'enrollments_created', enrollments_created,
    'offerings_processed', active_offering_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_department_timetable(uuid, text, smallint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_department_timetable(uuid, text, smallint)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
