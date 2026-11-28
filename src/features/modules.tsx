import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { Download, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { CollegeRole } from './registration'
import { parseStudyYears } from '../lib/studyYears'

type Props = { role: CollegeRole; userId: string }
type Related<T> = T | T[] | null
type Department = { id: string; code: string; name: string }
type Course = { id: string; code: string; name: string; department_id: string; credit_hours: number; is_active: boolean; study_years: number[] }
type Staff = { id: string; staff_number: string }
type Offering = {
  id: string
  academic_year: string
  term: number
  section: string
  lecturer_id: string | null
  student_selection_open?: boolean
  course: Related<Pick<Course, 'id' | 'code' | 'name' | 'department_id'> & {
    is_active?: boolean
    department?: Related<Pick<Department, 'code' | 'name'>>
  }>
}
type LecturerCourseRosterRow = { student_number: string; full_name: string }
type Slot = {
  id: string
  course_offering_id: string
  day_of_week: number
  starts_at: string
  ends_at: string
  room: string | null
  slot_status: 'scheduled' | 'cancelled'
  offering: Related<Offering>
}
type Exam = {
  id: string
  course_offering_id: string
  title: string
  scheduled_at: string | null
  max_score: number
  exam_status: string
  offering: Related<Offering>
}
type FeeCharge = {
  id: string
  student_id: string
  description: string
  academic_year: string
  amount: number
  currency: string
  due_on: string | null
}
type Payment = {
  id: string
  student_id: string
  charge_id: string | null
  amount: number
  currency: string
  payment_status: string
  paid_at: string | null
}
type Book = {
  id: string
  isbn: string | null
  title: string
  author: string | null
  total_copies: number
  available_copies: number
  shelf_location: string | null
}
type Loan = {
  id: string
  book_id: string
  student_id: string
  checked_out_at: string
  due_at: string
  returned_at: string | null
  book: Related<Pick<Book, 'title' | 'isbn'>>
}

const academicAdminRoles: CollegeRole[] = ['super_admin', 'college_admin', 'academic_registrar']
const financeRoles: CollegeRole[] = ['super_admin', 'college_admin', 'finance_accountant', 'bursar']
const libraryRoles: CollegeRole[] = ['super_admin', 'college_admin', 'librarian']
const examAdminRoles: CollegeRole[] = ['super_admin', 'college_admin', 'academic_registrar', 'examination_officer']
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function related<T>(value: Related<T> | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined
}

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const values = [
      'message' in error ? error.message : null,
      'details' in error ? error.details : null,
      'hint' in error ? error.hint : null,
    ]
    const messages = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (messages.length) return messages.join(' ')
  }
  return 'The request could not be completed.'
}

function usePageData(loader: () => Promise<void>, dependencies: unknown[]) {
  useEffect(() => {
    void loader()
  }, dependencies)
}

function PageFrame({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </div>
  )
}

function Notice({ error, success }: { error: string; success: string }) {
  if (!error && !success) return null
  return (
    <p aria-live="polite" className={`rounded-xl px-3 py-2.5 text-xs ${error ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'}`}>
      {error || success}
    </p>
  )
}

function Loading({ label = 'Loading records…' }: { label?: string }) {
  return <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={16} />{label}</div>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 p-5 text-center text-sm text-slate-500 dark:border-slate-700">{children}</p>
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><h3 className="mb-4 text-sm font-bold">{title}</h3>{children}</section>
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead><tr className="border-b border-slate-100 text-slate-500 dark:border-slate-800">{headers.map((header) => <th className="px-3 py-2 font-semibold" key={header}>{header}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody>
      </table>
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="px-3 py-3 align-middle">{children}</td>
}

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return <label className="block"><span className="mb-1.5 block text-[11px] font-semibold">{label}</span>{children}</label>
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`form-input ${props.className ?? ''}`} />
}

function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`form-input ${props.className ?? ''}`} />
}

function downloadCsv(filename: string, rows: Array<Record<string, string | number | null>>) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const escape = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const csv = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]
    .map((row) => row.map(escape).join(','))
    .join('\r\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export function AcademicsPage({ role, userId }: Props) {
  const canManage = academicAdminRoles.includes(role) || role === 'department_head'
  const [departments, setDepartments] = useState<Department[]>([])
  const [studentDepartment, setStudentDepartment] = useState<Department | null>(null)
  const [studentStudyYear, setStudentStudyYear] = useState<number | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [availableStudentOfferings, setAvailableStudentOfferings] = useState<Offering[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [selectingOfferingId, setSelectingOfferingId] = useState('')
  const [selectedRosterOfferingId, setSelectedRosterOfferingId] = useState('')
  const [lecturerRoster, setLecturerRoster] = useState<LecturerCourseRosterRow[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [courseForm, setCourseForm] = useState({ department_id: '', code: '', name: '', credit_hours: '1', study_years: '1' })
  const [offeringForm, setOfferingForm] = useState({ course_id: '', lecturer_id: '', academic_year: '', term: '1', section: 'A' })

  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const ownStaffResult = role === 'department_head'
        ? await supabase.from('college_staff').select('department_id').eq('id', userId).maybeSingle()
        : { data: null, error: null }
      if (ownStaffResult.error) throw ownStaffResult.error
      const ownDepartmentId = ownStaffResult.data?.department_id ?? null

      const studentResult = role === 'student'
        ? await supabase.from('college_students')
          .select('student_status,department_id,study_year,department:college_departments(id,code,name)')
          .eq('id', userId)
          .maybeSingle()
        : null
      if (studentResult?.error) throw studentResult.error

      const [departmentResult, courseResult, offeringResult, enrollmentResult, courseYearResult] = await Promise.all([
        supabase.from('college_departments').select('id,code,name').eq('is_active', true).order('name'),
        supabase.from('college_courses').select('id,code,name,department_id,credit_hours,is_active').order('code'),
        supabase.from('college_course_offerings').select('id,academic_year,term,section,lecturer_id,student_selection_open,course:college_courses(id,code,name,department_id,is_active)').order('academic_year', { ascending: false }),
        role === 'student'
          ? supabase.from('college_enrollments').select('course_offering_id,enrollment_status').eq('student_id', userId)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('college_course_study_years').select('course_id,study_year').order('study_year'),
      ])
      if (departmentResult.error) throw departmentResult.error
      if (courseResult.error) throw courseResult.error
      if (offeringResult.error) throw offeringResult.error
      if (enrollmentResult.error) throw enrollmentResult.error
      if (courseYearResult.error) throw courseYearResult.error
      const allOfferings = (offeringResult.data ?? []) as Offering[]
      const studentRecord = studentResult?.data as {
        student_status: string
        department_id: string
        study_year: number | null
        department: Related<Department>
      } | null
      const studentDepartment = related(studentRecord?.department) ?? null
      const studentDepartmentId = studentRecord?.department_id
      const studentStudyYear = studentRecord?.study_year == null
        ? null
        : Number(studentRecord.study_year)
      const studyYearsByCourse = new Map<string, number[]>()
      for (const assignment of courseYearResult.data ?? []) {
        const years = studyYearsByCourse.get(assignment.course_id) ?? []
        years.push(Number(assignment.study_year))
        studyYearsByCourse.set(assignment.course_id, years)
      }
      const allCourses: Course[] = (courseResult.data ?? []).map((course) => ({
        ...course,
        study_years: studyYearsByCourse.get(course.id) ?? [],
      }))
      const enrolledOfferingIds = new Set((enrollmentResult.data ?? [])
        .filter((enrollment) => enrollment.enrollment_status === 'enrolled')
        .map((enrollment) => enrollment.course_offering_id))
      const studentEnrollmentIds = new Set((enrollmentResult.data ?? [])
        .map((enrollment) => enrollment.course_offering_id))
      const visibleOfferings = role === 'lecturer'
        ? allOfferings.filter((offering) => offering.lecturer_id === userId)
        : role === 'student'
          ? allOfferings.filter((offering) => enrolledOfferingIds.has(offering.id))
          : canManage
            ? allOfferings.filter((offering) =>
                role !== 'department_head'
                || !ownDepartmentId
                || related(offering.course)?.department_id === ownDepartmentId)
            : []
      const availableStudentOfferings = role === 'student'
        && studentRecord?.student_status === 'active'
        && studentDepartmentId
        && studentStudyYear
        ? allOfferings.filter((offering) =>
            offering.student_selection_open
            && related(offering.course)?.is_active
            && related(offering.course)?.department_id === studentDepartmentId
            && studyYearsByCourse.get(related(offering.course)?.id ?? '')?.includes(studentStudyYear)
            && !studentEnrollmentIds.has(offering.id))
        : []
      const offeringCourseIds = new Set(visibleOfferings.map((offering) => related(offering.course)?.id).filter((id): id is string => Boolean(id)))
      const visibleDepartments = role === 'department_head' && ownDepartmentId
        ? (departmentResult.data ?? []).filter((department) => department.id === ownDepartmentId)
        : (departmentResult.data ?? [])
      setDepartments(visibleDepartments)
      setStudentDepartment(role === 'student' ? studentDepartment : null)
      setStudentStudyYear(role === 'student' ? studentStudyYear : null)
      setCourses(canManage
        ? allCourses.filter((course) =>
            role !== 'department_head'
            || !ownDepartmentId
            || course.department_id === ownDepartmentId)
        : role === 'student' && studentDepartmentId && studentStudyYear
          ? allCourses.filter((course) =>
              course.is_active
              && course.department_id === studentDepartmentId
              && course.study_years.includes(studentStudyYear))
          : allCourses.filter((course) => offeringCourseIds.has(course.id)))
      setOfferings(visibleOfferings)
      setAvailableStudentOfferings(availableStudentOfferings)
      if (canManage) {
        const staffResult = await supabase.from('college_staff').select('id,staff_number').eq('employment_status', 'active').order('staff_number')
        if (staffResult.error) throw staffResult.error
        setStaff(staffResult.data ?? [])
      }
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [canManage, role, userId])
  usePageData(load, [load])

  async function selectCourseOffering(offering: Offering) {
    if (!supabase || role !== 'student') return
    setSelectingOfferingId(offering.id)
    setError(''); setSuccess('')
    try {
      const { error: selectionError } = await supabase.rpc('select_college_course_offering', {
        p_course_offering_id: offering.id,
      })
      if (selectionError) throw selectionError
      setSuccess(`${related(offering.course)?.code ?? 'Course'} selected and enrolled. It will now appear in your timetable.`)
      await load()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setSelectingOfferingId('')
    }
  }

  async function loadLecturerRoster(offering: Offering) {
    if (!supabase || role !== 'lecturer') return
    setSelectedRosterOfferingId(offering.id)
    setRosterLoading(true)
    setError('')
    try {
      const { data, error: rosterError } = await supabase.rpc('get_college_lecturer_course_roster', {
        p_course_offering_id: offering.id,
      })
      if (rosterError) throw rosterError
      setLecturerRoster((data ?? []) as LecturerCourseRosterRow[])
    } catch (caught) {
      setLecturerRoster([])
      setError(messageOf(caught))
    } finally {
      setRosterLoading(false)
    }
  }

  async function addCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    const studyYears = parseStudyYears(courseForm.study_years)
    if (!studyYears?.length) {
      setError('Enter at least one unique study year from 1 to 20.')
      return
    }
    setBusy(true); setError(''); setSuccess('')
    const { data: createdCourse, error: insertError } = await supabase.from('college_courses').insert({
      department_id: courseForm.department_id,
      code: courseForm.code.trim(),
      name: courseForm.name.trim(),
      credit_hours: Number(courseForm.credit_hours),
    }).select('id').single()
    if (insertError) { setBusy(false); setError(insertError.message); return }
    const { error: studyYearError } = await supabase.rpc('set_college_course_study_years', {
      p_course_id: createdCourse.id,
      p_study_years: studyYears,
    })
    setBusy(false)
    if (studyYearError) {
      setError(`Subject created, but study-year assignment failed: ${studyYearError.message}`)
      await load()
      return
    }
    setCourseForm({ department_id: '', code: '', name: '', credit_hours: '1', study_years: '1' })
    setSuccess(`Subject created for year${studyYears.length === 1 ? '' : 's'} ${studyYears.join(', ')}.`)
    await load()
  }

  async function addOffering(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: insertError } = await supabase.from('college_course_offerings').insert({
      course_id: offeringForm.course_id,
      lecturer_id: offeringForm.lecturer_id || null,
      academic_year: offeringForm.academic_year.trim(),
      term: Number(offeringForm.term),
      section: offeringForm.section.trim(),
    })
    setBusy(false)
    if (insertError) { setError(insertError.message); return }
    setOfferingForm({ course_id: '', lecturer_id: '', academic_year: '', term: '1', section: 'A' })
    setSuccess('Course offering created.')
    await load()
  }

  async function toggleCourse(course: Course) {
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: updateError } = await supabase.from('college_courses').update({ is_active: !course.is_active }).eq('id', course.id)
    setBusy(false)
    if (updateError) { setError(updateError.message); return }
    setSuccess(`Subject ${course.is_active ? 'deactivated' : 'activated'}.`)
    await load()
  }

  async function toggleStudentSelection(offering: Offering) {
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const nextState = !offering.student_selection_open
    const { error: updateError } = await supabase.from('college_course_offerings')
      .update({ student_selection_open: nextState })
      .eq('id', offering.id)
    setBusy(false)
    if (updateError) { setError(messageOf(updateError)); return }
    setSuccess(`Student course selection ${nextState ? 'opened' : 'closed'} for ${related(offering.course)?.code ?? 'this course offering'}.`)
    await load()
  }

  return (
    <PageFrame title="Academics" description="Manage subjects, course offerings and academic delivery." actions={<button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>}>
      <Notice error={error} success={success} />
      {canManage && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Create subject">
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={addCourse}>
              <Field label="Department"><SelectInput onChange={(event) => setCourseForm({ ...courseForm, department_id: event.target.value })} required value={courseForm.department_id}><option value="">Select department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.code} · {department.name}</option>)}</SelectInput></Field>
              <Field label="Subject code"><TextInput maxLength={40} onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })} required value={courseForm.code} /></Field>
              <Field label="Subject name"><TextInput maxLength={160} onChange={(event) => setCourseForm({ ...courseForm, name: event.target.value })} required value={courseForm.name} /></Field>
              <Field label="Credit hours"><TextInput min="1" onChange={(event) => setCourseForm({ ...courseForm, credit_hours: event.target.value })} required type="number" value={courseForm.credit_hours} /></Field>
              <Field label="Study years (comma-separated)"><TextInput maxLength={60} onChange={(event) => setCourseForm({ ...courseForm, study_years: event.target.value })} placeholder="1, 2" required value={courseForm.study_years} /></Field>
              <button className="primary-button sm:col-span-2" disabled={busy || !departments.length} type="submit"><Plus size={14} /> Create subject</button>
            </form>
          </Panel>
          <Panel title="Create course offering">
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={addOffering}>
              <Field label="Subject"><SelectInput onChange={(event) => setOfferingForm({ ...offeringForm, course_id: event.target.value })} required value={offeringForm.course_id}><option value="">Select subject</option>{courses.filter((course) => course.is_active).map((course) => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}</SelectInput></Field>
              <Field label="Lecturer"><SelectInput onChange={(event) => setOfferingForm({ ...offeringForm, lecturer_id: event.target.value })} value={offeringForm.lecturer_id}><option value="">Unassigned</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.staff_number}</option>)}</SelectInput></Field>
              <Field label="Academic year"><TextInput maxLength={20} onChange={(event) => setOfferingForm({ ...offeringForm, academic_year: event.target.value })} placeholder="2026/2027" required value={offeringForm.academic_year} /></Field>
              <Field label="Semester / term"><TextInput min="1" onChange={(event) => setOfferingForm({ ...offeringForm, term: event.target.value })} required type="number" value={offeringForm.term} /></Field>
              <Field label="Section / class"><TextInput maxLength={40} onChange={(event) => setOfferingForm({ ...offeringForm, section: event.target.value })} required value={offeringForm.section} /></Field>
              <button className="primary-button self-end" disabled={busy || !courses.length} type="submit"><Plus size={14} /> Create offering</button>
            </form>
          </Panel>
        </div>
      )}
      {role === 'student' && (
        <Panel title="My department">
          {studentDepartment
            ? <p className="text-sm font-semibold">{studentDepartment.code} · {studentDepartment.name}</p>
            : <Empty>No department is assigned to your account yet. Contact the registrar.</Empty>}
        </Panel>
      )}
      {loading ? <Loading /> : (
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title={role === 'student' ? `Year ${studentStudyYear ?? 'not assigned'} subjects (${courses.length})` : `Subjects (${courses.length})`}>
            {courses.length ? (
              <Table headers={['Code', 'Subject', 'Department', 'Credits', 'Status', ...(canManage ? ['Study years', 'Action'] : [])]}>
                {courses.map((course) => <Row key={course.id}>
                  <Cell>{course.code}</Cell>
                  <Cell>{course.name}</Cell>
                  <Cell>{departments.find((department) => department.id === course.department_id)?.code ?? studentDepartment?.code ?? '—'}</Cell>
                  <Cell>{course.credit_hours}</Cell>
                  <Cell>{course.is_active ? 'Active' : 'Inactive'}</Cell>
                  {canManage && <Cell>{course.study_years.length ? course.study_years.map((year) => `Year ${year}`).join(', ') : 'Unassigned'}</Cell>}
                  {canManage && <Cell><button className="text-indigo-700 dark:text-indigo-300" disabled={busy} onClick={() => void toggleCourse(course)} type="button">{course.is_active ? 'Deactivate' : 'Activate'}</button></Cell>}
                </Row>)}
              </Table>
            ) : <Empty>{role === 'student'
              ? 'No active subjects are assigned to your department and study year yet. Contact the registrar or department head.'
              : 'No subjects are recorded.'}</Empty>}
          </Panel>
          <Panel title={`${role === 'student' ? 'My enrolled offerings' : 'Course offerings'} (${offerings.length})`}>
            {offerings.length ? <Table headers={['Subject', 'Academic year', 'Term', 'Section', 'Lecturer', ...(canManage ? ['Course selection'] : role === 'lecturer' ? ['Roster'] : [])]}>{offerings.map((offering) => <Row key={offering.id}><Cell>{related(offering.course)?.code ?? '—'} · {related(offering.course)?.name ?? ''}</Cell><Cell>{offering.academic_year}</Cell><Cell>{offering.term}</Cell><Cell>{offering.section}</Cell><Cell>{offering.lecturer_id ? staff.find((member) => member.id === offering.lecturer_id)?.staff_number ?? 'Assigned' : 'Unassigned'}</Cell>{canManage && <Cell><button className="text-indigo-700 dark:text-indigo-300" disabled={busy} onClick={() => void toggleStudentSelection(offering)} type="button">{offering.student_selection_open ? 'Close selection' : 'Open selection'}</button></Cell>}{role === 'lecturer' && <Cell><button className="text-indigo-700 dark:text-indigo-300" disabled={rosterLoading} onClick={() => void loadLecturerRoster(offering)} type="button">{selectedRosterOfferingId === offering.id && rosterLoading ? 'Loading…' : 'View students'}</button></Cell>}</Row>)}</Table> : <Empty>{role === 'student' ? 'You are not enrolled in any course offerings yet.' : 'No course offerings are recorded.'}</Empty>}
          </Panel>
        </div>
      )}
      {role === 'student' && (
        <Panel title={`Open course offerings (${availableStudentOfferings.length})`}>
          <p className="mb-4 text-xs text-slate-500">Select an offering published by the college in your department. Selection immediately enrolls you, and its timetable becomes visible in the Timetable page.</p>
          {availableStudentOfferings.length ? (
            <Table headers={['Subject', 'Academic year', 'Term', 'Section', 'Action']}>
              {availableStudentOfferings.map((offering) => <Row key={offering.id}>
                <Cell>{related(offering.course)?.code} · {related(offering.course)?.name}</Cell>
                <Cell>{offering.academic_year}</Cell>
                <Cell>{offering.term}</Cell>
                <Cell>{offering.section}</Cell>
                <Cell><button className="text-indigo-700 dark:text-indigo-300" disabled={Boolean(selectingOfferingId)} onClick={() => void selectCourseOffering(offering)} type="button">{selectingOfferingId === offering.id ? 'Enrolling…' : 'Select course'}</button></Cell>
              </Row>)}
            </Table>
          ) : <Empty>No open course offerings are available for your department.</Empty>}
        </Panel>
      )}
      {role === 'lecturer' && selectedRosterOfferingId && (
        <Panel title={`Enrolled students · ${related(offerings.find((offering) => offering.id === selectedRosterOfferingId)?.course)?.code ?? 'Course'}`}>
          {rosterLoading ? <Loading /> : lecturerRoster.length ? (
            <Table headers={['Student name', 'Student number']}>
              {lecturerRoster.map((student) => <Row key={student.student_number}><Cell>{student.full_name || '—'}</Cell><Cell>{student.student_number}</Cell></Row>)}
            </Table>
          ) : <Empty>No enrolled students are recorded for this course offering.</Empty>}
        </Panel>
      )}
    </PageFrame>
  )
}

export function TimetablePage({ role, userId }: Props) {
  const canManage = academicAdminRoles.includes(role)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [lecturers, setLecturers] = useState<Array<{ id: string; staff_number: string; profile: { full_name: string } | Array<{ full_name: string }> | null }>>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [editingId, setEditingId] = useState('')
  const [form, setForm] = useState({ course_offering_id: '', day_of_week: '1', starts_at: '09:00', ends_at: '10:00', room: '' })

  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [offeringResult, enrollmentResult] = await Promise.all([
        supabase.from('college_course_offerings').select('id,academic_year,term,section,lecturer_id,course:college_courses(id,code,name,department_id,department:college_departments(code,name))').order('academic_year', { ascending: false }),
        role === 'student'
          ? supabase.from('college_enrollments').select('course_offering_id').eq('student_id', userId).eq('enrollment_status', 'enrolled')
          : Promise.resolve({ data: [], error: null }),
      ])
      if (offeringResult.error) throw offeringResult.error
      if (enrollmentResult.error) throw enrollmentResult.error
      const allOfferings = (offeringResult.data ?? []) as Offering[]
      const visibleOfferings = role === 'lecturer'
        ? allOfferings.filter((offering) => offering.lecturer_id === userId)
        : role === 'student'
          ? allOfferings.filter((offering) => enrollmentResult.data?.some((enrollment) => enrollment.course_offering_id === offering.id))
          : canManage
            ? allOfferings
            : []
      setOfferings(visibleOfferings)
      const offeringIds = visibleOfferings.map((offering) => offering.id)
      if (!offeringIds.length) { setSlots([]); return }
      const slotResult = await supabase.from('college_timetable_slots')
        .select('id,course_offering_id,day_of_week,starts_at,ends_at,room,slot_status,offering:college_course_offerings(id,academic_year,term,section,lecturer_id,course:college_courses(id,code,name,department_id,department:college_departments(code,name)))')
        .in('course_offering_id', offeringIds)
        .order('day_of_week')
        .order('starts_at')
      if (slotResult.error) {
        if (slotResult.error.message.includes('slot_status')) {
          throw new Error('The timetable database is missing slot_status. Apply migration 20261127100000_fix_timetable_slot_status_and_student_scope.sql in Supabase, then retry.')
        }
        throw slotResult.error
      }
      setSlots((slotResult.data ?? []) as Slot[])
      if (offeringIds.length) {
        const lecturerIds = [...new Set(visibleOfferings.map((offering) => offering.lecturer_id).filter((id): id is string => Boolean(id)))]
        if (lecturerIds.length) {
          const lecturerResult = await supabase
            .from('college_staff')
            .select('id,staff_number,profile:college_profiles(full_name)')
            .in('id', lecturerIds)
          if (lecturerResult.error) throw lecturerResult.error
          setLecturers((lecturerResult.data ?? []) as typeof lecturers)
        } else {
          setLecturers([])
        }
      } else {
        setLecturers([])
      }
    } catch (caught) { setError(messageOf(caught)) } finally { setLoading(false) }
  }, [canManage, role, userId])
  usePageData(load, [load])

  async function saveSlot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const chosen = offerings.find((offering) => offering.id === form.course_offering_id)
    const conflicts = slots.filter((slot) => {
      if (slot.id === editingId || slot.slot_status !== 'scheduled' || slot.day_of_week !== Number(form.day_of_week)
        || !(form.starts_at < slot.ends_at && form.ends_at > slot.starts_at)) return false
      const other = related(slot.offering)
      if (!chosen || !other || chosen.academic_year !== other.academic_year || chosen.term !== other.term) return false
      const sameOffering = slot.course_offering_id === form.course_offering_id
      const sameLecturer = Boolean(chosen.lecturer_id && chosen.lecturer_id === other.lecturer_id)
      const sameRoom = Boolean(form.room.trim() && form.room.trim().toLowerCase() === slot.room?.trim().toLowerCase())
      return sameOffering || sameLecturer || sameRoom
    })
    if (conflicts.length) {
      setBusy(false)
      setError('This slot overlaps an existing class, lecturer or room booking. Resolve the conflict before saving.')
      return
    }
    const values = {
      course_offering_id: form.course_offering_id,
      day_of_week: Number(form.day_of_week),
      starts_at: form.starts_at,
      ends_at: form.ends_at,
      room: form.room.trim() || null,
    }
    try {
      const result = editingId
        ? await supabase.from('college_timetable_slots').update(values).eq('id', editingId)
        : await supabase.from('college_timetable_slots').insert(values)
      if (result.error) { setError(messageOf(result.error)); return }
      setSuccess(editingId ? 'Timetable entry updated.' : 'Timetable entry created.')
      setEditingId('')
      setForm({ course_offering_id: '', day_of_week: '1', starts_at: '09:00', ends_at: '10:00', room: '' })
      await load()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  async function cancelSlot(slot: Slot) {
    if (!supabase || !canManage || slot.slot_status === 'cancelled') return
    if (!window.confirm('Cancel this timetable entry? The entry will be retained in the timetable history.')) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const { error: updateError } = await supabase.from('college_timetable_slots').update({ slot_status: 'cancelled' }).eq('id', slot.id)
      if (updateError) { setError(messageOf(updateError)); return }
      setSuccess('Timetable entry cancelled.')
      await load()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  function editSlot(slot: Slot) {
    setEditingId(slot.id)
    setForm({
      course_offering_id: slot.course_offering_id,
      day_of_week: String(slot.day_of_week),
      starts_at: slot.starts_at.slice(0, 5),
      ends_at: slot.ends_at.slice(0, 5),
      room: slot.room ?? '',
    })
  }

  const visibleSlots = slots.filter((slot) => {
    const offering = related(slot.offering)
    const course = related(offering?.course)
    const department = related(course?.department)
    const searchable = `${dayNames[slot.day_of_week - 1] ?? ''} ${department?.code ?? ''} ${department?.name ?? ''} ${course?.code ?? ''} ${course?.name ?? ''} ${offering?.section ?? ''} ${offering?.academic_year ?? ''} ${slot.room ?? ''}`.toLowerCase()
    return searchable.includes(filter.trim().toLowerCase())
  })

  return (
    <PageFrame title="Timetable" description="View your assigned or enrolled timetable. Authorized academic staff can create, edit and cancel entries; the database rejects overlapping active bookings." actions={<button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>}>
      <Notice error={error} success={success} />
      {canManage && <Panel title={editingId ? 'Edit timetable entry' : 'Add timetable entry'}><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={saveSlot}>
        <Field label="Department / course offering"><SelectInput onChange={(event) => setForm({ ...form, course_offering_id: event.target.value })} required value={form.course_offering_id}><option value="">Select offering</option>{offerings.map((offering) => {
          const course = related(offering.course)
          const department = related(course?.department)
          return <option key={offering.id} value={offering.id}>{department?.code ?? 'Department'} · {course?.code} · {offering.section} · {offering.academic_year}</option>
        })}</SelectInput></Field>
        <Field label="Day"><SelectInput onChange={(event) => setForm({ ...form, day_of_week: event.target.value })} value={form.day_of_week}>{dayNames.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</SelectInput></Field>
        <Field label="Room"><TextInput maxLength={80} onChange={(event) => setForm({ ...form, room: event.target.value })} value={form.room} /></Field>
        <Field label="Start time"><TextInput onChange={(event) => setForm({ ...form, starts_at: event.target.value })} required type="time" value={form.starts_at} /></Field>
        <Field label="End time"><TextInput onChange={(event) => setForm({ ...form, ends_at: event.target.value })} required type="time" value={form.ends_at} /></Field>
        <div className="flex items-center gap-2"><button className="primary-button self-end" disabled={busy || !offerings.length} type="submit"><Plus size={14} /> {editingId ? 'Save entry' : 'Add entry'}</button>{editingId && <button className="secondary-button self-end" onClick={() => { setEditingId(''); setForm({ course_offering_id: '', day_of_week: '1', starts_at: '09:00', ends_at: '10:00', room: '' }) }} type="button">Cancel edit</button>}</div>
      </form></Panel>}
      <Field label="Filter visible entries"><TextInput onChange={(event) => setFilter(event.target.value)} placeholder="Search subject, class, day or room" value={filter} /></Field>
      {loading ? <Loading /> : visibleSlots.length ? <Panel title={`Entries (${visibleSlots.length})`}><Table headers={['Day', 'Time', 'Department', 'Subject', 'Class', 'Lecturer', 'Room', 'Status', ...(canManage ? ['Actions'] : [])]}>{visibleSlots.map((slot) => {
        const offering = related(slot.offering)
        const course = related(offering?.course)
        const department = related(course?.department)
        const lecturer = lecturers.find((member) => member.id === offering?.lecturer_id)
        const lecturerProfile = Array.isArray(lecturer?.profile) ? lecturer?.profile[0] : lecturer?.profile
        return <Row key={slot.id}><Cell>{dayNames[slot.day_of_week - 1] ?? slot.day_of_week}</Cell><Cell>{slot.starts_at.slice(0, 5)}–{slot.ends_at.slice(0, 5)}</Cell><Cell>{department?.code ?? '—'} · {department?.name ?? ''}</Cell><Cell>{course?.code} · {course?.name}</Cell><Cell>{offering?.section ?? '—'}</Cell><Cell>{lecturerProfile?.full_name ?? lecturer?.staff_number ?? 'Unassigned'}</Cell><Cell>{slot.room ?? '—'}</Cell><Cell>{slot.slot_status}</Cell>{canManage && <Cell><div className="flex gap-2">{slot.slot_status === 'scheduled' && <><button className="text-indigo-700 dark:text-indigo-300" disabled={busy} onClick={() => editSlot(slot)} type="button">Edit</button><button className="text-rose-700" disabled={busy} onClick={() => void cancelSlot(slot)} type="button">Cancel</button></>}</div></Cell>}</Row>
      })}</Table></Panel> : <Empty>No timetable entries are visible to this account.</Empty>}
      {!canManage && <p className="text-xs text-slate-500">Your account has read-only timetable access.</p>}
    </PageFrame>
  )
}

export function ExaminationsPage({ role, userId }: Props) {
  const canManage = examAdminRoles.includes(role) || role === 'lecturer'
  const canEnterResults = canManage
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  const [publishedResults, setPublishedResults] = useState<Array<{ title: string; score: number; max_score: number; graded_at: string }>>([])
  const [requests, setRequests] = useState<Array<{ id: string; type: 'examination' | 'semester'; examTitle?: string; reason: string; status: 'submitted' }>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [examForm, setExamForm] = useState({ course_offering_id: '', title: '', scheduled_at: '', max_score: '100' })
  const [resultForm, setResultForm] = useState({ examination_id: '', student_id: '', score: '' })
  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [offeringResult, examResult, enrollmentResult, resultResult] = await Promise.all([
        supabase.from('college_course_offerings').select('id,academic_year,term,section,lecturer_id,course:college_courses(id,code,name,department_id)').order('academic_year', { ascending: false }),
        supabase.from('college_examinations').select('id,course_offering_id,title,scheduled_at,max_score,exam_status,offering:college_course_offerings(id,academic_year,term,section,lecturer_id,course:college_courses(id,code,name,department_id))').order('scheduled_at', { ascending: false }),
        role === 'student'
          ? supabase.from('college_enrollments').select('course_offering_id').eq('student_id', userId).eq('enrollment_status', 'enrolled')
          : Promise.resolve({ data: [], error: null }),
        role === 'student'
          ? supabase.from('college_exam_results').select('score,graded_at,examination:college_examinations(title,max_score)').eq('student_id', userId).not('published_at', 'is', null).order('graded_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ])
      if (offeringResult.error) throw offeringResult.error
      if (examResult.error) throw examResult.error
      if (enrollmentResult.error) throw enrollmentResult.error
      if (resultResult.error) throw resultResult.error
      const allOfferings = (offeringResult.data ?? []) as Offering[]
      setOfferings(role === 'lecturer'
        ? allOfferings.filter((offering) => offering.lecturer_id === userId)
        : allOfferings)
      const allExams = (examResult.data ?? []) as Exam[]
      setExams(role === 'student'
        ? allExams.filter((exam) => (enrollmentResult.data ?? []).some((row) => row.course_offering_id === exam.course_offering_id))
        : allExams)
      setPublishedResults(((resultResult.data ?? []) as Array<{ score: number; graded_at: string; examination: { title: string; max_score: number } | Array<{ title: string; max_score: number }> | null }>).flatMap((row) => {
        const exam = Array.isArray(row.examination) ? row.examination[0] : row.examination
        return exam ? [{ title: exam.title, score: Number(row.score), max_score: Number(exam.max_score), graded_at: row.graded_at }] : []
      }))
    } catch (caught) { setError(messageOf(caught)) } finally { setLoading(false) }
  }, [role, userId])
  usePageData(load, [load])

  async function createExam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: insertError } = await supabase.from('college_examinations').insert({
      course_offering_id: examForm.course_offering_id,
      title: examForm.title.trim(),
      scheduled_at: examForm.scheduled_at ? new Date(examForm.scheduled_at).toISOString() : null,
      max_score: Number(examForm.max_score),
      created_by: userId,
    })
    setBusy(false)
    if (insertError) { setError(insertError.message); return }
    setSuccess('Examination created.')
    setExamForm({ course_offering_id: '', title: '', scheduled_at: '', max_score: '100' })
    await load()
  }

  async function enterResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canEnterResults) return
    setBusy(true); setError(''); setSuccess('')
    const exam = exams.find((item) => item.id === resultForm.examination_id)
    if (!exam) { setBusy(false); setError('Select a valid examination.'); return }
    const { data: existing, error: lookupError } = await supabase.from('college_exam_results').select('id').eq('examination_id', exam.id).eq('student_id', resultForm.student_id.trim()).maybeSingle()
    if (lookupError) { setBusy(false); setError(lookupError.message); return }
    const values = { score: Number(resultForm.score), graded_by: userId, graded_at: new Date().toISOString() }
    const result = existing
      ? await supabase.from('college_exam_results').update(values).eq('id', existing.id)
      : await supabase.from('college_exam_results').insert({ ...values, examination_id: exam.id, student_id: resultForm.student_id.trim() })
    setBusy(false)
    if (result.error) { setError(result.error.message); return }
    setSuccess('Result saved. It remains private until published.')
    setResultForm({ ...resultForm, student_id: '', score: '' })
  }

  async function updateExamStatus(exam: Exam, status: string) {
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: updateError } = await supabase.from('college_examinations').update({ exam_status: status }).eq('id', exam.id)
    setBusy(false)
    if (updateError) { setError(updateError.message); return }
    setSuccess(`Examination ${status}.`)
    await load()
  }

  async function publishResults(exam: Exam) {
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: updateError } = await supabase.from('college_exam_results').update({ published_at: new Date().toISOString() }).eq('examination_id', exam.id)
    setBusy(false)
    if (updateError) { setError(updateError.message); return }
    setSuccess('Existing results for this examination were published.')
  }

  useEffect(() => {
    if (role !== 'student') return
    try {
      const saved = window.localStorage.getItem(`stjames-postponement-${userId}`)
      setRequests(saved ? JSON.parse(saved) : [])
    } catch {
      setRequests([])
    }
  }, [role, userId])

  function submitPostponement(type: 'examination' | 'semester', examTitle = '') {
    const reason = window.prompt(type === 'examination'
      ? `Why should ${examTitle || 'this examination'} be postponed?`
      : 'Why should the semester be postponed?')
    if (!reason?.trim()) return
    const next = [{ id: crypto.randomUUID(), type, examTitle: examTitle || undefined, reason: reason.trim(), status: 'submitted' as const }, ...requests]
    setRequests(next)
    window.localStorage.setItem(`stjames-postponement-${userId}`, JSON.stringify(next))
    setSuccess('Postponement request saved locally. Submit it to the registrar for formal approval.')
  }

  function downloadTicket(exam: Exam) {
    const offering = related(exam.offering)
    const course = related(offering?.course)
    const ticket = `<!doctype html><html><head><title>Examination Ticket</title><style>body{font-family:Arial;margin:40px;color:#0f172a}.ticket{max-width:700px;margin:auto;border:3px solid #1d4ed8;border-radius:16px;padding:32px}.title{font-size:24px;font-weight:bold}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px}.label{font-size:11px;text-transform:uppercase;color:#64748b}.value{font-size:14px;font-weight:bold;margin-top:4px}@media print{body{margin:0}.ticket{border-width:2px}}</style></head><body><div class="ticket"><div class="title">ST JAMES COLLEGE</div><p>Student Examination Ticket</p><div class="grid"><div><div class="label">Student ID</div><div class="value">${userId}</div></div><div><div class="label">Course</div><div class="value">${course?.code ?? ''} ${course?.name ?? ''}</div></div><div><div class="label">Examination</div><div class="value">${exam.title}</div></div><div><div class="label">Date & Time</div><div class="value">${exam.scheduled_at ? new Date(exam.scheduled_at).toLocaleString() : 'To be announced'}</div></div><div><div class="label">Venue</div><div class="value">Assigned by examination office</div></div><div><div class="label">Status</div><div class="value">${exam.exam_status}</div></div></div></div></body></html>`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([ticket], { type: 'text/html;charset=utf-8' }))
    link.download = `examination-ticket-${exam.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <PageFrame title="Examinations" description="Create exams, record scores and publish results using the existing course-offering and result records." actions={<button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>}>
      <Notice error={error} success={success} />
      {role === 'student' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title={`Coursework and published results (${publishedResults.length})`}>
            {publishedResults.length ? <Table headers={['Assessment', 'Score', 'Out of', 'Graded']}>{publishedResults.map((result, index) => <Row key={`${result.title}-${index}`}><Cell>{result.title}</Cell><Cell>{result.score}</Cell><Cell>{result.max_score}</Cell><Cell>{new Date(result.graded_at).toLocaleDateString()}</Cell></Row>)}</Table> : <Empty>No published coursework or results are available yet.</Empty>}
          </Panel>
          <Panel title="Postponement requests">
            <button className="secondary-button" onClick={() => submitPostponement('semester')} type="button">Postpone semester</button>
            {requests.length ? <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">{requests.map((request) => <div className="py-3 text-xs" key={request.id}><p className="font-semibold">{request.type === 'semester' ? 'Semester postponement' : `Examination · ${request.examTitle ?? ''}`}</p><p className="mt-1 text-slate-500">{request.reason}</p><p className="mt-1 text-[10px] text-amber-700">Submitted · awaiting formal review</p></div>)}</div> : <p className="mt-4 text-xs text-slate-500">No postponement requests saved on this device.</p>}
          </Panel>
        </div>
      )}
      {canManage && <Panel title="Create examination"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={createExam}>
        <Field label="Course offering"><SelectInput onChange={(event) => setExamForm({ ...examForm, course_offering_id: event.target.value })} required value={examForm.course_offering_id}><option value="">Select offering</option>{offerings.map((offering) => <option key={offering.id} value={offering.id}>{related(offering.course)?.code} · {offering.section} · {offering.academic_year}</option>)}</SelectInput></Field>
        <Field label="Title"><TextInput maxLength={160} onChange={(event) => setExamForm({ ...examForm, title: event.target.value })} required value={examForm.title} /></Field>
        <Field label="Date and time"><TextInput onChange={(event) => setExamForm({ ...examForm, scheduled_at: event.target.value })} type="datetime-local" value={examForm.scheduled_at} /></Field>
        <Field label="Maximum score"><TextInput min="0.01" onChange={(event) => setExamForm({ ...examForm, max_score: event.target.value })} required type="number" value={examForm.max_score} /></Field>
        <button className="primary-button sm:col-span-2 lg:col-span-4" disabled={busy || !offerings.length} type="submit"><Plus size={14} /> Create examination</button>
      </form></Panel>}
      {canEnterResults && <Panel title="Record or update a result"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={enterResult}>
        <Field label="Examination"><SelectInput onChange={(event) => setResultForm({ ...resultForm, examination_id: event.target.value })} required value={resultForm.examination_id}><option value="">Select examination</option>{exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.title} · {related(related(exam.offering)?.course)?.code}</option>)}</SelectInput></Field>
        <Field label="Student account ID"><TextInput onChange={(event) => setResultForm({ ...resultForm, student_id: event.target.value })} required value={resultForm.student_id} /></Field>
        <Field label="Score"><TextInput min="0" onChange={(event) => setResultForm({ ...resultForm, score: event.target.value })} required step="0.01" type="number" value={resultForm.score} /></Field>
        <button className="primary-button self-end" disabled={busy || !exams.length} type="submit">Save result</button>
      </form><p className="mt-3 text-[11px] text-slate-500">Student identity and maximum-score checks are enforced by database policies and constraints. Use the student’s account UUID; results remain unpublished until an authorized officer publishes them.</p></Panel>}
      {loading ? <Loading /> : exams.length ? <Panel title={`Examinations (${exams.length})`}><Table headers={['Title', 'Course offering', 'Scheduled', 'Maximum', 'Status', 'Actions']}>{exams.map((exam) => <Row key={exam.id}><Cell>{exam.title}</Cell><Cell>{related(related(exam.offering)?.course)?.code} · {related(exam.offering)?.section} · {related(exam.offering)?.academic_year}</Cell><Cell>{exam.scheduled_at ? new Date(exam.scheduled_at).toLocaleString() : 'Not scheduled'}</Cell><Cell>{exam.max_score}</Cell><Cell>{exam.exam_status}</Cell><Cell><div className="flex flex-wrap gap-2">{role === 'student' && exam.exam_status !== 'cancelled' && <><button className="text-indigo-700 dark:text-indigo-300" onClick={() => downloadTicket(exam)} type="button">Download ticket</button><button className="text-amber-700 dark:text-amber-300" onClick={() => submitPostponement('examination', exam.title)} type="button">Postpone</button></>}{canManage && exam.exam_status !== 'cancelled' && <button className="text-rose-700" disabled={busy} onClick={() => void updateExamStatus(exam, 'cancelled')} type="button">Cancel</button>}{examAdminRoles.includes(role) && <button className="text-indigo-700 dark:text-indigo-300" disabled={busy} onClick={() => void publishResults(exam)} type="button">Publish results</button>}</div></Cell></Row>)}</Table></Panel> : <Empty>No examinations are recorded.</Empty>}
    </PageFrame>
  )
}

export function FinancePage({ role, userId }: Props) {
  const canManage = financeRoles.includes(role)
  const [charges, setCharges] = useState<FeeCharge[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [financeTab, setFinanceTab] = useState<'generate' | 'bills' | 'payments' | 'statement'>('generate')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [form, setForm] = useState({ student_id: '', description: '', academic_year: '', amount: '', due_on: '' })
  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [chargeResult, paymentResult] = await Promise.all([
        supabase.from('college_fee_charges').select('id,student_id,description,academic_year,amount,currency,due_on').order('created_at', { ascending: false }),
        supabase.from('college_payments').select('id,student_id,charge_id,amount,currency,payment_status,paid_at').order('created_at', { ascending: false }),
      ])
      if (chargeResult.error) throw chargeResult.error
      if (paymentResult.error) throw paymentResult.error
      setCharges(chargeResult.data ?? [])
      setPayments(paymentResult.data ?? [])
    } catch (caught) { setError(messageOf(caught)) } finally { setLoading(false) }
  }, [])
  usePageData(load, [load])

  async function addCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: insertError } = await supabase.from('college_fee_charges').insert({
      student_id: form.student_id.trim(),
      description: form.description.trim(),
      academic_year: form.academic_year.trim(),
      amount: Number(form.amount),
      due_on: form.due_on || null,
      created_by: userId,
    })
    setBusy(false)
    if (insertError) { setError(insertError.message); return }
    setSuccess('Fee charge created.')
    setForm({ student_id: '', description: '', academic_year: '', amount: '', due_on: '' })
    await load()
  }

  const balanceByStudent = useMemo(() => {
    const totals = new Map<string, number>()
    for (const charge of charges) totals.set(charge.student_id, (totals.get(charge.student_id) ?? 0) + Number(charge.amount))
    for (const payment of payments) if (payment.payment_status === 'confirmed') totals.set(payment.student_id, (totals.get(payment.student_id) ?? 0) - Number(payment.amount))
    return totals
  }, [charges, payments])

  function downloadStatement() {
    const ownCharges = role === 'student' ? charges.filter((charge) => charge.student_id === userId) : charges
    const ownPayments = role === 'student' ? payments.filter((payment) => payment.student_id === userId) : payments
    const rows: Array<Record<string, string | number | null>> = [
      ...ownCharges.map((charge) => ({ type: 'bill', description: charge.description, academic_year: charge.academic_year, amount: Number(charge.amount), currency: charge.currency, date: charge.due_on })),
      ...ownPayments.map((payment) => ({ type: `payment:${payment.payment_status}`, description: 'Payment', academic_year: '', amount: Number(payment.amount), currency: payment.currency, date: payment.paid_at })),
    ]
    downloadCsv(`student-finance-statement-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  }

  function downloadBill(charge: FeeCharge) {
    const balance = balanceByStudent.get(charge.student_id) ?? 0
    downloadCsv(`student-bill-${charge.academic_year}-${charge.description.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`, [{
      student_account: charge.student_id,
      description: charge.description,
      academic_year: charge.academic_year,
      amount: Number(charge.amount),
      currency: charge.currency,
      due_on: charge.due_on,
      account_balance: balance,
    }])
  }

  return (
    <PageFrame title="Finance" description="Review fee charges and verified payment records. Payment entry is intentionally unavailable until a trusted payment integration is configured." actions={<button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>}>
      <Notice error={error} success={success} />
      {role === 'student' && (
        <>
          <div className="flex flex-wrap gap-2">
            {[
              ['generate', 'Generate bill'],
              ['bills', 'My bills'],
              ['payments', 'My payments'],
              ['statement', 'My statement'],
            ].map(([tab, label]) => <button className={financeTab === tab ? 'primary-button' : 'secondary-button'} key={tab} onClick={() => setFinanceTab(tab as typeof financeTab)} type="button">{label}</button>)}
          </div>
          {loading ? <Loading /> : (
            <div className="grid gap-5">
              {financeTab === 'generate' && <Panel title="Generate bill"><p className="mb-4 text-xs text-slate-500">Download a bill for an outstanding fee charge. This is an account document, not a payment receipt.</p>{charges.filter((charge) => charge.student_id === userId).length ? <Table headers={['Description', 'Academic year', 'Amount', 'Due', 'Action']}>{charges.filter((charge) => charge.student_id === userId).map((charge) => <Row key={charge.id}><Cell>{charge.description}</Cell><Cell>{charge.academic_year}</Cell><Cell>{Number(charge.amount).toLocaleString()} {charge.currency}</Cell><Cell>{charge.due_on ?? '—'}</Cell><Cell><button className="text-indigo-700 dark:text-indigo-300" onClick={() => downloadBill(charge)} type="button">Download bill</button></Cell></Row>)}</Table> : <Empty>No bills are available to generate.</Empty>}</Panel>}
              {financeTab === 'bills' && <Panel title="My bills"><Table headers={['Description', 'Academic year', 'Amount', 'Due', 'Balance']}>{charges.filter((charge) => charge.student_id === userId).map((charge) => <Row key={charge.id}><Cell>{charge.description}</Cell><Cell>{charge.academic_year}</Cell><Cell>{Number(charge.amount).toLocaleString()} {charge.currency}</Cell><Cell>{charge.due_on ?? '—'}</Cell><Cell>{(balanceByStudent.get(charge.student_id) ?? 0).toLocaleString()} TZS</Cell></Row>)}</Table></Panel>}
              {financeTab === 'payments' && <Panel title="My payments"><Table headers={['Amount', 'Status', 'Paid date', 'Reference']}>{payments.filter((payment) => payment.student_id === userId).map((payment) => <Row key={payment.id}><Cell>{Number(payment.amount).toLocaleString()} {payment.currency}</Cell><Cell>{payment.payment_status}</Cell><Cell>{payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : '—'}</Cell><Cell>{payment.charge_id ?? '—'}</Cell></Row>)}</Table></Panel>}
              {financeTab === 'statement' && <Panel title="My statement"><div className="flex items-center justify-between gap-3"><div><p className="text-2xl font-bold">{(balanceByStudent.get(userId) ?? 0).toLocaleString()} TZS</p><p className="mt-1 text-xs text-slate-500">Current outstanding balance</p></div><button className="secondary-button" onClick={downloadStatement} type="button"><Download size={14} /> Download statement</button></div></Panel>}
            </div>
          )}
        </>
      )}
      {canManage && <Panel title="Add fee charge"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={addCharge}>
        <Field label="Student account ID"><TextInput onChange={(event) => setForm({ ...form, student_id: event.target.value })} required value={form.student_id} /></Field>
        <Field label="Description"><TextInput maxLength={160} onChange={(event) => setForm({ ...form, description: event.target.value })} required value={form.description} /></Field>
        <Field label="Academic year"><TextInput maxLength={20} onChange={(event) => setForm({ ...form, academic_year: event.target.value })} required value={form.academic_year} /></Field>
        <Field label="Amount (TZS)"><TextInput min="0" onChange={(event) => setForm({ ...form, amount: event.target.value })} required step="0.01" type="number" value={form.amount} /></Field>
        <Field label="Due date"><TextInput onChange={(event) => setForm({ ...form, due_on: event.target.value })} type="date" value={form.due_on} /></Field>
        <button className="primary-button self-end" disabled={busy} type="submit"><Plus size={14} /> Add charge</button>
      </form></Panel>}
      {role !== 'student' && (loading ? <Loading /> : <div className="grid gap-5">
        <Panel title={`Fee charges (${charges.length})`}>
          {charges.length ? <Table headers={['Student', 'Description', 'Academic year', 'Amount', 'Due', 'Balance across visible records']}>{charges.map((charge) => <Row key={charge.id}><Cell>{charge.student_id}</Cell><Cell>{charge.description}</Cell><Cell>{charge.academic_year}</Cell><Cell>{Number(charge.amount).toLocaleString()} {charge.currency}</Cell><Cell>{charge.due_on ?? '—'}</Cell><Cell>{(balanceByStudent.get(charge.student_id) ?? 0).toLocaleString()} TZS</Cell></Row>)}</Table> : <Empty>No fee charges are visible to this account.</Empty>}
        </Panel>
        <Panel title={`Payments (${payments.length}) · read only`}>
          {payments.length ? <Table headers={['Student', 'Amount', 'Status', 'Payment date', 'Reference']}>{payments.map((payment) => <Row key={payment.id}><Cell>{payment.student_id}</Cell><Cell>{Number(payment.amount).toLocaleString()} {payment.currency}</Cell><Cell>{payment.payment_status}</Cell><Cell>{payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : '—'}</Cell><Cell>{payment.charge_id ?? '—'}</Cell></Row>)}</Table> : <Empty>No payment records are visible to this account. No payment has been recorded by this screen.</Empty>}
        </Panel>
      </div>)}
    </PageFrame>
  )
}

export function LibraryPage({ role }: Props) {
  const canManage = libraryRoles.includes(role)
  const [books, setBooks] = useState<Book[]>([])
  const [loans, setLoans] = useState<Loan[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [form, setForm] = useState({ isbn: '', title: '', author: '', total_copies: '1', shelf_location: '' })
  const [loanForm, setLoanForm] = useState({ book_id: '', student_id: '', due_at: '' })
  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [bookResult, loanResult] = await Promise.all([
        supabase.from('college_library_books').select('id,isbn,title,author,total_copies,available_copies,shelf_location').order('title'),
        supabase.from('college_library_loans').select('id,book_id,student_id,checked_out_at,due_at,returned_at,book:college_library_books(title,isbn)').order('checked_out_at', { ascending: false }),
      ])
      if (bookResult.error) throw bookResult.error
      if (loanResult.error) throw loanResult.error
      setBooks(bookResult.data ?? [])
      setLoans((loanResult.data ?? []) as Loan[])
    } catch (caught) { setError(messageOf(caught)) } finally { setLoading(false) }
  }, [])
  usePageData(load, [load])

  async function addBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const total = Number(form.total_copies)
    const { error: insertError } = await supabase.from('college_library_books').insert({
      isbn: form.isbn.trim() || null,
      title: form.title.trim(),
      author: form.author.trim() || null,
      total_copies: total,
      available_copies: total,
      shelf_location: form.shelf_location.trim() || null,
    })
    setBusy(false)
    if (insertError) { setError(insertError.message); return }
    setSuccess('Book added to the catalogue.')
    setForm({ isbn: '', title: '', author: '', total_copies: '1', shelf_location: '' })
    await load()
  }

  async function issueBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const dueAt = new Date(`${loanForm.due_at}T23:59:59`)
    if (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date()) {
      setBusy(false)
      setError('Choose a due date in the future.')
      return
    }
    const { error: issueError } = await supabase.rpc('issue_college_library_loan', {
      p_book_id: loanForm.book_id,
      p_student_id: loanForm.student_id.trim(),
      p_due_at: dueAt.toISOString(),
    })
    setBusy(false)
    if (issueError) { setError(issueError.message); return }
    setSuccess('Book issued.')
    setLoanForm({ book_id: '', student_id: '', due_at: '' })
    await load()
  }

  async function returnBook(loan: Loan) {
    if (!supabase || !canManage) return
    setBusy(true); setError(''); setSuccess('')
    const { error: updateError } = await supabase.rpc('return_college_library_loan', { p_loan_id: loan.id })
    setBusy(false)
    if (updateError) { setError(updateError.message); return }
    setSuccess('Return recorded and book inventory updated.')
    await load()
  }

  return (
    <PageFrame title="Library" description="Browse the catalogue and loan history. Inventory management is available to authorized library staff." actions={<button className="secondary-button" onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>}>
      <Notice error={error} success={success} />
      {canManage && <>
        <Panel title="Register book"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={addBook}>
          <Field label="Title"><TextInput maxLength={240} onChange={(event) => setForm({ ...form, title: event.target.value })} required value={form.title} /></Field>
          <Field label="Author"><TextInput maxLength={180} onChange={(event) => setForm({ ...form, author: event.target.value })} value={form.author} /></Field>
          <Field label="ISBN"><TextInput maxLength={40} onChange={(event) => setForm({ ...form, isbn: event.target.value })} value={form.isbn} /></Field>
          <Field label="Total copies"><TextInput min="0" onChange={(event) => setForm({ ...form, total_copies: event.target.value })} required type="number" value={form.total_copies} /></Field>
          <Field label="Shelf location"><TextInput maxLength={100} onChange={(event) => setForm({ ...form, shelf_location: event.target.value })} value={form.shelf_location} /></Field>
          <button className="primary-button self-end" disabled={busy} type="submit"><Plus size={14} /> Add book</button>
        </form></Panel>
        <Panel title="Issue a book"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={issueBook}>
          <Field label="Book"><SelectInput onChange={(event) => setLoanForm({ ...loanForm, book_id: event.target.value })} required value={loanForm.book_id}><option value="">Select book</option>{books.filter((book) => book.available_copies > 0).map((book) => <option key={book.id} value={book.id}>{book.title} ({book.available_copies} available)</option>)}</SelectInput></Field>
          <Field label="Student account ID"><TextInput onChange={(event) => setLoanForm({ ...loanForm, student_id: event.target.value })} required value={loanForm.student_id} /></Field>
          <Field label="Due date"><TextInput onChange={(event) => setLoanForm({ ...loanForm, due_at: event.target.value })} required type="date" value={loanForm.due_at} /></Field>
          <button className="primary-button self-end" type="submit">Issue book</button>
        </form></Panel>
      </>}
      {loading ? <Loading /> : <div className="grid gap-5">
        <Panel title={`Catalogue (${books.length})`}>{books.length ? <Table headers={['Title', 'Author', 'ISBN', 'Available', 'Total', 'Shelf']}>{books.map((book) => <Row key={book.id}><Cell>{book.title}</Cell><Cell>{book.author ?? '—'}</Cell><Cell>{book.isbn ?? '—'}</Cell><Cell>{book.available_copies}</Cell><Cell>{book.total_copies}</Cell><Cell>{book.shelf_location ?? '—'}</Cell></Row>)}</Table> : <Empty>No books are recorded.</Empty>}</Panel>
        <Panel title={`Loan history (${loans.length})`}>{loans.length ? <Table headers={['Book', 'Student', 'Checked out', 'Due', 'Returned', ...(canManage ? ['Action'] : [])]}>{loans.map((loan) => <Row key={loan.id}><Cell>{related(loan.book)?.title ?? loan.book_id}</Cell><Cell>{loan.student_id}</Cell><Cell>{new Date(loan.checked_out_at).toLocaleDateString()}</Cell><Cell>{new Date(loan.due_at).toLocaleDateString()}</Cell><Cell>{loan.returned_at ? new Date(loan.returned_at).toLocaleDateString() : 'Outstanding'}</Cell>{canManage && <Cell>{!loan.returned_at && <button className="text-indigo-700 dark:text-indigo-300" disabled={busy} onClick={() => void returnBook(loan)} type="button">Record return</button>}</Cell>}</Row>)}</Table> : <Empty>No loan records are visible to this account.</Empty>}</Panel>
      </div>}
    </PageFrame>
  )
}

export function ReportsPage({ role }: Props) {
  const canReadFinance = financeRoles.includes(role)
  const canReadStudents = academicAdminRoles.includes(role) || role === 'examination_officer'
  const [report, setReport] = useState('attendance')
  const [rows, setRows] = useState<Array<Record<string, string | number | null>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!supabase) { setError('Supabase is not configured.'); return }
    setLoading(true); setError(''); setSuccess('')
    try {
      let nextRows: Array<Record<string, string | number | null>> = []
      if (report === 'attendance') {
        const { data, error: queryError } = await supabase.from('college_attendance_records').select('id,student_id,session_id,attendance_status,marked_at').order('marked_at', { ascending: false }).limit(500)
        if (queryError) throw queryError
        nextRows = (data ?? []).map((row) => ({ student_id: row.student_id, session_id: row.session_id, status: row.attendance_status, marked_at: row.marked_at }))
      } else if (report === 'examinations') {
        const { data, error: queryError } = await supabase.from('college_exam_results').select('id,student_id,examination_id,score,graded_at,published_at').order('graded_at', { ascending: false }).limit(500)
        if (queryError) throw queryError
        nextRows = (data ?? []).map((row) => ({ student_id: row.student_id, examination_id: row.examination_id, score: row.score, graded_at: row.graded_at, published: row.published_at ? 'yes' : 'no' }))
      } else if (report === 'finance' && canReadFinance) {
        const [charges, payments] = await Promise.all([
          supabase.from('college_fee_charges').select('student_id,description,academic_year,amount,currency,due_on').limit(500),
          supabase.from('college_payments').select('student_id,amount,currency,payment_status,paid_at').limit(500),
        ])
        if (charges.error) throw charges.error
        if (payments.error) throw payments.error
        nextRows = [
          ...(charges.data ?? []).map((row) => ({ type: 'charge', student_id: row.student_id, description: row.description, year: row.academic_year, amount: row.amount, currency: row.currency, due_on: row.due_on })),
          ...(payments.data ?? []).map((row) => ({ type: `payment:${row.payment_status}`, student_id: row.student_id, amount: row.amount, currency: row.currency, paid_at: row.paid_at })),
        ]
      } else if (report === 'library') {
        const { data, error: queryError } = await supabase.from('college_library_loans').select('student_id,book_id,checked_out_at,due_at,returned_at').order('checked_out_at', { ascending: false }).limit(500)
        if (queryError) throw queryError
        nextRows = (data ?? []).map((row) => ({ student_id: row.student_id, book_id: row.book_id, checked_out_at: row.checked_out_at, due_at: row.due_at, returned_at: row.returned_at }))
      } else if (report === 'students' && canReadStudents) {
        const { data, error: queryError } = await supabase.from('college_students').select('student_number,student_status,department_id,admitted_on').limit(500)
        if (queryError) throw queryError
        nextRows = (data ?? []).map((row) => ({ student_number: row.student_number, status: row.student_status, department_id: row.department_id, admitted_on: row.admitted_on }))
      } else {
        throw new Error('Your role is not permitted to view this report.')
      }
      setRows(nextRows)
      if (!nextRows.length) setSuccess('No records match this report. Nothing was exported.')
    } catch (caught) { setError(messageOf(caught)) } finally { setLoading(false) }
  }

  const reportOptions = useMemo(() => [
    { value: 'attendance', label: 'Attendance' },
    { value: 'examinations', label: 'Examinations' },
    ...(canReadFinance ? [{ value: 'finance', label: 'Finance' }] : []),
    { value: 'library', label: 'Library' },
    ...(canReadStudents ? [{ value: 'students', label: 'Students' }] : []),
  ], [canReadFinance, canReadStudents])

  return (
    <PageFrame title="Reports" description="Export records returned by Supabase Row Level Security. Results are limited to the latest 500 records per selected report." actions={<div className="flex gap-2"><button className="secondary-button" disabled={!rows.length} onClick={() => downloadCsv(`${report}-report.csv`, rows)} type="button"><Download size={14} /> Export CSV</button><button className="secondary-button" disabled={!rows.length} onClick={() => window.print()} type="button">Print / PDF</button></div>}>
      <Notice error={error} success={success} />
      <Panel title="Select report"><form className="flex flex-col gap-3 sm:flex-row" onSubmit={load}>
        <SelectInput aria-label="Report type" onChange={(event) => { setReport(event.target.value); setRows([]); setSuccess(''); setError('') }} value={report}>{reportOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</SelectInput>
        <button className="primary-button" disabled={loading} type="submit">{loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />} Run report</button>
      </form></Panel>
      {loading ? <Loading /> : rows.length ? <Panel title={`${rows.length} records`}><Table headers={Object.keys(rows[0])}>{rows.map((row, index) => <Row key={index}>{Object.values(row).map((value, cellIndex) => <Cell key={cellIndex}>{value ?? '—'}</Cell>)}</Row>)}</Table></Panel> : <Empty>Run a report to load current records permitted for your role.</Empty>}
    </PageFrame>
  )
}
