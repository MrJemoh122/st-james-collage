# St James College Management Portal

Responsive React + TypeScript web portal starter for St James College Institute of Technology.

## Run locally

1. Install Node.js LTS.
2. Run `npm install`.
3. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`.
4. Run `npm run dev`.

The supplied `.env.local` targets the existing St James Supabase project and is ignored by Git. Never put a Supabase secret or service-role key in frontend configuration.

## Deploy to GitHub Pages

The GitHub Actions workflow builds the app and deploys `dist` on pushes to `main` or `master`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. Add the Actions repository variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` so sign-in can connect to Supabase; `.env.local` is intentionally not committed.

## Current scope

The portal includes Supabase email/password sign-in and student applicant account creation, password reset, session restoration, role-filtered navigation, responsive layouts, module search, and persisted light/dark mode. Students can request currently open course offerings; the registrar assigns a programme and year and confirms the requested enrolments during approval. Lecturer and non-teaching staff accounts are created by administrators and activated using a Supabase email invitation. The attendance module provides lecturer QR sessions, authenticated student scanning, attendance review and correction, audit trails, and filtered exports. Academics, timetable, examinations, finance, library, and reports query the college tables and expose the operations supported by the checked-in schema and RLS policies. The UI surfaces query and permission errors rather than substituting sample data.

The app does not apply migrations to the live database or create sample records. Student dashboard metrics are scoped to the signed-in student's own enrolments, attendance, upcoming examinations, published results, and visible fee records.

## Database setup

Review the migrations against the live database and apply them in this order:

1. `supabase/migrations/20261117090000_create_college_schema.sql` — additive baseline for profiles, students, staff, academics, attendance, fees, library loans, timetables, audit events, and Row Level Security.
2. `supabase/migrations/20261117100000_add_non_teaching_staff_role.sql` — compatibility migration for existing databases that already applied an earlier baseline.
3. `supabase/migrations/20261117101000_registration_workflows.sql` — private application storage, student/staff applications, and approval workflows.
4. `supabase/migrations/20261117110000_secure_qr_attendance.sql` — adds QR token/audit storage and trusted attendance RPCs while retaining existing attendance records.
5. `supabase/migrations/20261119090000_college_module_integrity.sql` — adds timetable cancellation state and server-side conflict checks, and adds atomic, role-checked library issue/return operations that maintain book availability.
6. `supabase/migrations/20261119100000_student_registration_numbers.sql` — configures qualification levels and globally unique course codes, issues immutable `STJIT/COURSE_CODE/0001/YEAR` registration numbers atomically, and records authorized programme transfers.
7. `supabase/migrations/20261120100000_programme_year_course_enrollments.sql` — records each applicant's year of study, maps course offerings to programme years, and synchronizes mapped offerings to active students' course enrollments.
8. `supabase/migrations/20261121130000_student_course_choices_and_staff_invites.sql` — enables student course-offering requests, registrar placement and confirmed enrolment, and the trusted staff-account provisioning RPC.
9. `supabase/migrations/20261121150000_department_management.sql` — grants authenticated users the table permission required for department deletion (still restricted by the admin-only RLS policy), adds audited department-head assignment, and configures account suspension and personal-record deletion.
10. `supabase/migrations/20261123120000_subject_core_and_hod_assignments.sql` — adds normalized subjects, subject cores, lecturer-subject assignments, department-head appointment history, department-scoped RLS, and HOD-authorized lecturer provisioning.
11. `supabase/migrations/20261127100000_fix_timetable_slot_status_and_student_scope.sql` — ensures timetable cancellation status exists and limits student timetable reads to course offerings they are actively enrolled in.
12. `supabase/migrations/20261127110000_student_department_course_selection_and_lecturer_rosters.sql` — collects a department instead of a programme on student applications, lets active students immediately enroll in college-open offerings within their programme department, and exposes assigned lecturers' enrolled student rosters.
13. `supabase/migrations/20261127120000_student_department_assignment.sql` — lets administrators assign a department and matching programme to pending applicants or transfer existing students, with server-side department checks.

Before applying any migration, compare it with the live schema and policies in the existing Supabase project. Migration 5 changes timetable read scope and library loan write permissions; reconcile existing library availability counts against outstanding loans before using the new issue/return workflow. Migration 6 requires existing programme codes to be 2–12 letters or numbers and globally unique regardless of letter case; inspect and resolve any invalid or duplicate codes before applying it. Apply migrations only after reviewing affected records and confirming the live schema matches their prerequisites.

After applying the reviewed migrations, create and verify the designated administrator through Supabase Auth, then run `supabase/setup_super_admin.sql` in the Supabase SQL Editor. The bootstrap assigns the super-admin role only to that verified account. Passwords are never stored in SQL or frontend code; use Supabase Auth to set or reset them.

To allow students and staff to sign in with their registration/staff number, deploy `supabase/functions/student-login` with JWT verification disabled (`supabase functions deploy student-login --no-verify-jwt`). Configure its `STUDENT_LOGIN_ALLOWED_ORIGINS` secret as a comma-separated list of the exact portal origins (scheme and host, without a trailing slash or deployment path), and ensure the function has the standard `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` secrets. The service-role key belongs only in the Edge Function environment and must never be added to frontend configuration. The function resolves student numbers (`STJIT/CICT/0001/2026`) and staff numbers (`STJ-S-2026-000001`) to their existing Auth account and exchanges the supplied password through Supabase Auth; users may continue to sign in with their email address as well. Password reset requests still require the account email.

Deploy `supabase/functions/create-staff-account` with JWT verification enabled (`supabase functions deploy create-staff-account`). For this GitHub Pages project, configure `APP_URL` as `https://mrjemoh122.github.io/st-james-collage` (no trailing slash); its CORS origin is `https://mrjemoh122.github.io`. Add the `APP_URL` value to Supabase Auth's allowed redirect URLs. Verify the function has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` available in its environment. The function validates the signed-in administrator, creates the Auth invitation, and uses the service-role key only inside the Edge Function to provision the staff record. Administrators create staff from the Staff page; invitees set their own passwords from the one-time email link.

Deploy `supabase/functions/manage-college-account` with JWT verification enabled (`supabase functions deploy manage-college-account`). It uses the same `APP_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` secrets as the staff invitation function. Only super admins can use it. Suspension blocks sign-in until restored; deletion removes the user's personal student/staff, academic, finance, application, and storage records while retaining shared institutional records and their audit history. Required staff attribution on retained records is transferred to the deleting super admin.

New users can create an account and submit a student application. Until an authorized super administrator, college administrator, or academic registrar approves the application, the account remains pending and cannot access college modules. Administrators should create course offerings and open student selection for the offerings that applicants may request. The registrar assigns each applicant's programme and year, then approves to enroll the selected offerings. Supabase Storage keeps application files private and limits uploads to 10 MB per file.

For QR attendance, assign lecturers to course offerings, map those offerings to each programme and year in Academics, and add timetable slots before opening a session. New admissions, assigned study years, and programme/year mappings synchronize active students into the matching course offerings; existing students with no recorded study year must have one assigned in the Students directory. The database still verifies the exact course-offering enrollment and server time when scanning, stores only a hash of each short-lived QR token, and prevents duplicate scans. Lecturer corrections require a reason and are auditable. Students use the camera scanner over HTTPS; lecturers can monitor attendance through Realtime with periodic refresh as a fallback. Apply the QR attendance migration and the programme-year enrollment migration before using this workflow.

Never put a Supabase secret or service-role key in frontend configuration. Payment writes remain disabled until a trusted payment-provider integration is configured.
