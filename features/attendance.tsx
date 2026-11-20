import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { BrowserQRCodeReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import { QRCodeSVG } from 'qrcode.react'
import {
  AlertCircle,
  ArrowDownToLine,
  Camera,
  CheckCircle2,
  Clock3,
  Download,
  LoaderCircle,
  MonitorUp,
  RefreshCw,
  RotateCw,
  ScanLine,
  ShieldCheck,
  Square,
  Users,
  X,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { CollegeRole } from './registration'

const timeZone = 'Africa/Dar_es_Salaam'
const adminRoles: CollegeRole[] = [
  'super_admin',
  'college_admin',
  'academic_registrar',
  'examination_officer',
]

type Props = { user: User; role: CollegeRole }
type Related<T> = T | T[] | null
type Course = { id: string; code: string; name: string; department_id: string }
type Offering = {
  id: string
  academic_year: string
  term: number
  section: string
  lecturer_id: string | null
  course: Related<Course>
}
type TimetableSlot = {
  id: string
  course_offering_id: string
  day_of_week: number
  starts_at: string
  ends_at: string
  room: string | null
}
type AttendanceSession = {
  id: string
  course_offering_id: string
  created_by: string
  starts_at: string
  ends_at: string
  session_status: 'scheduled' | 'open' | 'closed' | 'cancelled'
  timetable_slot_id: string | null
  attendance_opens_at: string
  late_after_at: string | null
  allow_late_scans: boolean
  manual_corrections_allowed: boolean
  qr_expires_at: string | null
  offering?: Offering
}
type RosterRow = {
  student_id: string
  full_name: string
  student_number: string
  attendance_status: 'present' | 'late' | 'absent' | 'excused' | 'not_scanned'
  marked_at: string | null
}
type CorrectionStatus = 'present' | 'late' | 'absent' | 'excused'
type ReportRow = {
  session_id: string
  session_start: string
  full_name: string
  student_number: string
  attendance_status: string
  marked_at: string
  course_code: string
  course_name: string
  section: string
  lecturer_name: string | null
  department_name: string
  academic_year: string
  term: number
}
type AuditRow = {
  id: string
  created_at: string
  action: string
  actor_name: string | null
  student_name: string | null
  student_number: string | null
  old_status: string | null
  new_status: string | null
  reason: string | null
}
type StudentHistoryEntry = {
  id: string
  attendance_status: string
  marked_at: string
  session: Related<{
    starts_at: string
    course_offering_id: string
    offering: Related<{
      academic_year: string
      term: number
      section: string
      course: Related<{ code: string; name: string }>
    }>
  }>
}
type SessionStart = {
  attendance_session_id: string
  plaintext_token: string
  token_expires_at: string
}

function relatedValue<T>(value: Related<T> | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined
}

function formatTanzaniaTime(value: string | Date | null | undefined) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date)
}

function formatCountdown(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function toTanzaniaInput(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const part = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]))
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`
}

function fromTanzaniaInput(value: string) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!matched) return null
  const [, year, month, day, hour, minute] = matched
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute))).toISOString()
}

function dateToTanzaniaStart(value: string, addDay = false) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!matched) return null
  const [, year, month, day] = matched
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + (addDay ? 1 : 0), -3)).toISOString()
}

function displayError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function StatusNotice({ children, error = false }: { children: string; error?: boolean }) {
  return (
    <div
      aria-live="polite"
      className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-5 ${
        error
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      }`}
    >
      {error ? <AlertCircle className="mt-0.5 shrink-0" size={15} /> : <CheckCircle2 className="mt-0.5 shrink-0" size={15} />}
      <span>{children}</span>
    </div>
  )
}

export function AttendancePage({ user, role }: Props) {
  if (role === 'student') return <StudentAttendance user={user} />
  if (role === 'lecturer' || adminRoles.includes(role)) {
    return <AttendanceManagement user={user} role={role} />
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
      Your role does not have permission to manage or view attendance records.
    </div>
  )
}

function AttendanceManagement({ user, role }: Props) {
  const isManager = adminRoles.includes(role)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [slots, setSlots] = useState<TimetableSlot[]>([])
  const [sessions, setSessions] = useState<AttendanceSession[]>([])
  const [selectedOfferingId, setSelectedOfferingId] = useState('')
  const [selectedTimetableSlotId, setSelectedTimetableSlotId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [rosterLoading, setRosterLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [rosterError, setRosterError] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [liveStatus, setLiveStatus] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [tokenSessionId, setTokenSessionId] = useState('')
  const [tokenExpiresAt, setTokenExpiresAt] = useState('')
  const [projecting, setProjecting] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const now = new Date()
  const [form, setForm] = useState(() => ({
    opensAt: toTanzaniaInput(now),
    lateAfterAt: toTanzaniaInput(new Date(now.getTime() + 15 * 60_000)),
    closesAt: toTanzaniaInput(new Date(now.getTime() + 60 * 60_000)),
    allowLateScans: true,
    allowCorrections: true,
  }))

  const loadWorkspace = useCallback(async () => {
    const client = supabase
    if (!client) {
      setWorkspaceError('Supabase is not configured.')
      setLoading(false)
      return
    }

    setLoading(true)
    setWorkspaceError('')
    let offeringQuery = client
      .from('college_course_offerings')
      .select('id,academic_year,term,section,lecturer_id,course:college_courses(id,code,name,department_id)')
      .order('academic_year', { ascending: false })
    if (!isManager) offeringQuery = offeringQuery.eq('lecturer_id', user.id)

    const { data: offeringData, error: offeringError } = await offeringQuery
    if (offeringError) {
      setWorkspaceError(offeringError.message)
      setLoading(false)
      return
    }
    const offeringRows = (offeringData ?? []) as unknown as Offering[]
    const offeringIds = offeringRows.map((offering) => offering.id)
    setOfferings(offeringRows)
    setSelectedOfferingId((current) =>
      offeringIds.includes(current) ? current : offeringIds[0] ?? '',
    )

    if (!offeringIds.length) {
      setSlots([])
      setSessions([])
      setRoster([])
      setSelectedSessionId('')
      setLoading(false)
      return
    }

    const [slotResult, sessionResult] = await Promise.all([
      client
        .from('college_timetable_slots')
        .select('id,course_offering_id,day_of_week,starts_at,ends_at,room')
        .in('course_offering_id', offeringIds)
        .order('day_of_week')
        .order('starts_at'),
      client
        .from('college_attendance_sessions')
        .select('id,course_offering_id,created_by,starts_at,ends_at,session_status,timetable_slot_id,attendance_opens_at,late_after_at,allow_late_scans,manual_corrections_allowed,qr_expires_at')
        .in('course_offering_id', offeringIds)
        .order('starts_at', { ascending: false })
        .limit(100),
    ])
    const dataError = slotResult.error ?? sessionResult.error
    if (dataError) {
      setWorkspaceError(dataError.message)
      setLoading(false)
      return
    }

    const courseByOffering = new Map(offeringRows.map((offering) => [offering.id, offering]))
    const sessionRows = ((sessionResult.data ?? []) as unknown as AttendanceSession[])
      .map((session) => ({ ...session, offering: courseByOffering.get(session.course_offering_id) }))
    setSlots((slotResult.data ?? []) as TimetableSlot[])
    setSessions(sessionRows)
    setSelectedSessionId((current) =>
      sessionRows.some((session) => session.id === current)
        ? current
        : sessionRows[0]?.id ?? '',
    )
    setLoading(false)
  }, [isManager, user.id])

  const loadRoster = useCallback(async (sessionId: string) => {
    if (!supabase || !sessionId) {
      setRoster([])
      return
    }
    setRosterLoading(true)
    setRosterError('')
    const { data, error } = await supabase.rpc('get_college_attendance_roster', {
      p_session_id: sessionId,
    })
    if (error) {
      setRosterError(error.message)
      setRoster([])
    } else {
      setRoster((data ?? []) as RosterRow[])
    }
    setRosterLoading(false)
  }, [])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    void loadRoster(selectedSessionId)
  }, [loadRoster, selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId || !supabase) {
      setLiveStatus('')
      return
    }

    setLiveStatus('Connecting to Supabase Realtime…')
    const channel = supabase
      .channel(`attendance-records-${selectedSessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'college_attendance_records',
          filter: `session_id=eq.${selectedSessionId}`,
        },
        () => void loadRoster(selectedSessionId),
      )
      .subscribe((status) => {
        setLiveStatus(status === 'SUBSCRIBED' ? 'SUBSCRIBED' : `Realtime status: ${status}`)
      })

    const refreshTimer = window.setInterval(() => void loadRoster(selectedSessionId), 10_000)
    return () => {
      window.clearInterval(refreshTimer)
      void supabase?.removeChannel(channel)
    }
  }, [loadRoster, selectedSessionId])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const availableSlots = useMemo(
    () => slots.filter((slot) => slot.course_offering_id === selectedOfferingId),
    [selectedOfferingId, slots],
  )
  useEffect(() => {
    setSelectedTimetableSlotId((current) =>
      availableSlots.some((slot) => slot.id === current)
        ? current
        : availableSlots[0]?.id ?? '',
    )
  }, [availableSlots])
  const sessionIsOpen = Boolean(
    selectedSession?.session_status === 'open'
    && new Date(selectedSession.attendance_opens_at).getTime() <= clock
    && new Date(selectedSession.ends_at).getTime() > clock,
  )
  const sessionSecondsRemaining = selectedSession
    ? Math.max(0, Math.ceil((new Date(selectedSession.ends_at).getTime() - clock) / 1000))
    : 0
  const sessionSecondsToOpen = selectedSession
    ? Math.max(0, Math.ceil((new Date(selectedSession.attendance_opens_at).getTime() - clock) / 1000))
    : 0
  const visibleToken = tokenSessionId === selectedSessionId ? sessionToken : ''
  const visibleExpiry = visibleToken && tokenSessionId === selectedSessionId
    ? tokenExpiresAt
    : selectedSession?.qr_expires_at ?? ''
  const tokenSecondsRemaining = visibleExpiry
    ? Math.max(0, Math.ceil((new Date(visibleExpiry).getTime() - clock) / 1000))
    : 0
  const rosterCounts = useMemo(() => ({
    enrolled: roster.length,
    present: roster.filter((row) => row.attendance_status === 'present').length,
    late: roster.filter((row) => row.attendance_status === 'late').length,
    absent: roster.filter((row) => row.attendance_status === 'absent').length,
    notScanned: roster.filter((row) => row.attendance_status === 'not_scanned').length,
  }), [roster])

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    const opensAt = fromTanzaniaInput(form.opensAt)
    const lateAfterAt = fromTanzaniaInput(form.lateAfterAt)
    const closesAt = fromTanzaniaInput(form.closesAt)
    if (!selectedOfferingId || !selectedTimetableSlotId) {
      setIsError(true)
      setMessage('Select an assigned course and timetable slot before opening attendance.')
      return
    }
    if (!opensAt || !lateAfterAt || !closesAt || opensAt >= closesAt || lateAfterAt < opensAt || lateAfterAt > closesAt) {
      setIsError(true)
      setMessage('Set valid Tanzania opening, late, and closing times in the correct order.')
      return
    }
    if (!supabase) {
      setIsError(true)
      setMessage('Supabase is not configured.')
      return
    }

    setWorking(true)
    const { data, error } = await supabase.rpc('start_college_attendance_session', {
      p_course_offering_id: selectedOfferingId,
      p_timetable_slot_id: selectedTimetableSlotId,
      p_opens_at: opensAt,
      p_closes_at: closesAt,
      p_late_after_at: lateAfterAt,
      p_allow_late_scans: form.allowLateScans,
      p_manual_corrections_allowed: form.allowCorrections,
    })
    setWorking(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    const result = ((data ?? []) as SessionStart[])[0]
    if (!result) {
      setIsError(true)
      setMessage('The server did not return the new session QR token.')
      return
    }
    setSelectedSessionId(result.attendance_session_id)
    setSessionToken(result.plaintext_token)
    setTokenSessionId(result.attendance_session_id)
    setTokenExpiresAt(result.token_expires_at)
    setMessage('Attendance session opened. Display the QR code for enrolled students to scan.')
    await loadWorkspace()
  }

  async function rotateToken() {
    if (!supabase || !selectedSession) return
    setWorking(true)
    setMessage('')
    const { data, error } = await supabase.rpc('rotate_college_attendance_qr_token', {
      p_session_id: selectedSession.id,
    })
    setWorking(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    const result = ((data ?? []) as { plaintext_token: string; token_expires_at: string }[])[0]
    if (!result) {
      setIsError(true)
      setMessage('The server did not return a replacement QR token.')
      return
    }
    setSessionToken(result.plaintext_token)
    setTokenSessionId(selectedSession.id)
    setTokenExpiresAt(result.token_expires_at)
    setIsError(false)
    setMessage('QR token rotated. The previously displayed code is no longer valid.')
    await loadWorkspace()
  }

  async function closeSession() {
    if (!supabase || !selectedSession) return
    if (!window.confirm('Close this attendance session and record any remaining enrolled students as absent?')) return
    setWorking(true)
    setMessage('')
    const { error } = await supabase.rpc('close_college_attendance_session', {
      p_session_id: selectedSession.id,
    })
    setWorking(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setSessionToken('')
    setTokenExpiresAt('')
    setIsError(false)
    setMessage('Session closed. Remaining enrolled students were recorded as absent.')
    await loadWorkspace()
    await loadRoster(selectedSession.id)
  }

  async function correctAttendance(studentId: string, status: CorrectionStatus, reason: string) {
    if (!supabase || !selectedSession) return false
    const { error } = await supabase.rpc('correct_college_attendance_record', {
      p_session_id: selectedSession.id,
      p_student_id: studentId,
      p_new_status: status,
      p_reason: reason,
    })
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return false
    }
    setIsError(false)
    setMessage('Attendance corrected. The reason was saved to the audit trail.')
    await loadRoster(selectedSession.id)
    return true
  }

  const selectedSessionSlot = slots.find((slot) => slot.id === selectedSession?.timetable_slot_id)
  const sessionLabel = selectedSession?.offering
    ? offeringLabel(selectedSession.offering)
    : 'Attendance session'

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium text-slate-500">Secure check-in · {timeZone}</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">QR attendance</h2>
          <p className="mt-2 text-sm text-slate-500">Open a timed session for an assigned course and monitor verified student scans.</p>
        </div>
        <button className="secondary-button w-fit" onClick={() => void loadWorkspace()} type="button">
          <RefreshCw size={14} /> Refresh workspace
        </button>
      </div>

      {message && <div className="mt-5"><StatusNotice error={isError}>{message}</StatusNotice></div>}
      {workspaceError && <div className="mt-5"><StatusNotice error>{workspaceError}</StatusNotice></div>}

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.4fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Lecturer controls</p>
              <h3 className="mt-1 text-base font-bold">Open attendance session</h3>
            </div>
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300"><ScanLine size={18} /></span>
          </div>
          {!loading && offerings.length === 0 ? (
            <p className="mt-5 rounded-xl bg-amber-50 p-4 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              No assigned course offerings were found. Ask the registrar to assign a lecturer, course, section, academic year, term, and timetable slot first.
            </p>
          ) : (
            <form className="mt-5 space-y-4" onSubmit={createSession}>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold">Course, academic session, and class</span>
                <select className="form-input" required value={selectedOfferingId} onChange={(event) => setSelectedOfferingId(event.target.value)}>
                  <option value="">Select a course offering</option>
                  {offerings.map((offering) => <option key={offering.id} value={offering.id}>{offeringLabel(offering)}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold">Timetable</span>
                <select className="form-input" required value={selectedTimetableSlotId} onChange={(event) => setSelectedTimetableSlotId(event.target.value)}>
                  <option value="">Select the scheduled timetable slot</option>
                  {availableSlots.map((slot) => <option key={slot.id} value={slot.id}>{slotLabel(slot)}</option>)}
                </select>
                {selectedOfferingId && availableSlots.length === 0 && <span className="mt-1 block text-[10px] text-rose-600">No timetable slots are assigned to this offering.</span>}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <DateTimeField label="Attendance opens" value={form.opensAt} onChange={(opensAt) => setForm((value) => ({ ...value, opensAt }))} />
                <DateTimeField label="Late threshold" value={form.lateAfterAt} onChange={(lateAfterAt) => setForm((value) => ({ ...value, lateAfterAt }))} />
                <DateTimeField label="Attendance closes" value={form.closesAt} onChange={(closesAt) => setForm((value) => ({ ...value, closesAt }))} />
              </div>
              <label className="flex items-start gap-2 text-xs leading-5">
                <input className="mt-1 accent-indigo-600" checked={form.allowLateScans} onChange={(event) => setForm((value) => ({ ...value, allowLateScans: event.target.checked }))} type="checkbox" />
                <span><span className="font-semibold">Allow late students to scan</span><span className="block text-[10px] text-slate-500">Late scans after the threshold are recorded as late until the session closes.</span></span>
              </label>
              <label className="flex items-start gap-2 text-xs leading-5">
                <input className="mt-1 accent-indigo-600" checked={form.allowCorrections} onChange={(event) => setForm((value) => ({ ...value, allowCorrections: event.target.checked }))} type="checkbox" />
                <span><span className="font-semibold">Allow manual corrections</span><span className="block text-[10px] text-slate-500">Corrections require a reason and are added to the audit log.</span></span>
              </label>
              <button className="primary-button h-11 w-full justify-center" disabled={working || loading || !selectedOfferingId || !selectedTimetableSlotId} type="submit">
                {working ? <LoaderCircle className="animate-spin" size={16} /> : <ScanLine size={16} />}
                {working ? 'Opening session…' : 'Open session and generate QR'}
              </button>
              <p className="text-[10px] leading-5 text-slate-500">Times are interpreted and displayed in Africa/Dar_es_Salaam. QR tokens are random, hashed in the database, and expire within two minutes.</p>
            </form>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p className="text-xs font-medium text-slate-500">Live session</p>
              <h3 className="mt-1 text-base font-bold">QR display and attendance</h3>
            </div>
            <select
              aria-label="Select attendance session"
              className="form-input max-w-full sm:max-w-[320px]"
              value={selectedSessionId}
              onChange={(event) => {
                setSelectedSessionId(event.target.value)
                setMessage('')
              }}
            >
              <option value="">Select a session</option>
              {sessions.map((session) => <option key={session.id} value={session.id}>{formatTanzaniaTime(session.starts_at)} · {session.offering ? offeringLabel(session.offering) : 'Course'}</option>)}
            </select>
          </div>

          {!selectedSession ? (
            <div className="mt-5 grid min-h-64 place-items-center rounded-xl border border-dashed border-slate-200 px-5 text-center dark:border-slate-700">
              <div>
                <ScanLine className="mx-auto text-slate-400" size={27} />
                <p className="mt-3 text-xs font-semibold">No attendance session selected</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">Open a session or select a previous class to see its roster and report.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${sessionIsOpen ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800'}`}>
                  {sessionIsOpen
                    ? 'Open'
                    : selectedSession.session_status === 'closed'
                      ? 'Closed'
                      : selectedSession.session_status === 'cancelled'
                        ? 'Cancelled'
                        : selectedSession.session_status === 'open'
                          && new Date(selectedSession.attendance_opens_at).getTime() > clock
                          ? 'Scheduled'
                          : 'Expired'}
                </span>
                <span className="text-xs font-semibold">{sessionLabel}</span>
                {selectedSessionSlot && <span className="text-[10px] text-slate-500">{slotLabel(selectedSessionSlot)}</span>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <MetricCard label="Enrolled" value={rosterCounts.enrolled} icon={<Users size={15} />} />
                <MetricCard label="Present" value={rosterCounts.present} tone="green" />
                <MetricCard label="Late" value={rosterCounts.late} tone="amber" />
                <MetricCard label="Absent" value={rosterCounts.absent} tone="rose" />
                <MetricCard label="Not scanned" value={rosterCounts.notScanned} />
              </div>
              <div className="mt-4 grid gap-4 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50 sm:grid-cols-[minmax(180px,1fr)_1fr]">
                <div className="flex min-h-[245px] items-center justify-center rounded-xl bg-white p-4 dark:bg-white">
                  {visibleToken && tokenSecondsRemaining > 0 && sessionIsOpen ? (
                    <QRCodeSVG value={`STJATT:${visibleToken}`} size={220} marginSize={4} title={`Attendance QR for ${sessionLabel}`} />
                  ) : (
                    <div className="max-w-[220px] text-center text-slate-500">
                      <ShieldCheck className="mx-auto text-indigo-500" size={24} />
                      <p className="mt-2 text-xs font-semibold text-slate-700">{sessionIsOpen ? 'Display a fresh QR code' : 'Attendance QR unavailable'}</p>
                      <p className="mt-1 text-[10px] leading-4">The QR contains only a short-lived session token, never student information.</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-col justify-center">
                  <p className="text-xs font-semibold">Session time</p>
                  <p className="mt-1 text-[11px] text-slate-500">Opens {formatTanzaniaTime(selectedSession.attendance_opens_at)}</p>
                  <p className="mt-1 text-[11px] text-slate-500">Closes {formatTanzaniaTime(selectedSession.ends_at)}</p>
                  {selectedSession.session_status === 'open' && (
                    <p className="mt-2 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                      {sessionIsOpen
                        ? `Session closes in ${formatCountdown(sessionSecondsRemaining)}`
                        : sessionSecondsToOpen > 0
                          ? `Session opens in ${formatCountdown(sessionSecondsToOpen)}`
                          : 'Session time has elapsed'}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-2 text-xs font-semibold">
                    <Clock3 size={15} className="text-indigo-600" />
                    {visibleExpiry && sessionIsOpen
                      ? tokenSecondsRemaining > 0
                        ? `QR expires in ${Math.floor(tokenSecondsRemaining / 60)}:${String(tokenSecondsRemaining % 60).padStart(2, '0')}`
                        : 'QR expired — rotate to continue'
                      : 'No active QR token'}
                  </div>
                  <p className="mt-2 text-[10px] leading-5 text-slate-500">Late after {formatTanzaniaTime(selectedSession.late_after_at)} · {selectedSession.allow_late_scans ? 'late scans allowed' : 'late scans blocked'}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {sessionIsOpen && (
                      <button className="primary-button h-10 justify-center" disabled={working} onClick={() => void rotateToken()} type="button">
                        {working ? <LoaderCircle className="animate-spin" size={14} /> : <RotateCw size={14} />}
                        {visibleToken ? 'Rotate QR' : 'Display QR'}
                      </button>
                    )}
                    {visibleToken && tokenSecondsRemaining > 0 && sessionIsOpen && (
                      <button className="secondary-button" onClick={() => setProjecting(true)} type="button">
                        <MonitorUp size={14} /> Project
                      </button>
                    )}
                    {selectedSession.session_status === 'open' && (
                      <button className="secondary-button text-rose-600" disabled={working} onClick={() => void closeSession()} type="button">
                        <Square size={13} /> Close session
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-[10px] text-slate-500">
                  <span className={`h-2 w-2 rounded-full ${liveStatus === 'SUBSCRIBED' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  {liveStatus === 'SUBSCRIBED' ? 'Realtime connected' : 'Realtime reconnecting; periodic refresh is active'}
                </p>
                <div className="flex gap-2">
                  <button className="secondary-button" onClick={() => void loadRoster(selectedSession.id)} type="button"><RefreshCw size={13} /> Refresh roster</button>
                  <button className="secondary-button" disabled={!roster.length} onClick={() => downloadRoster(sessionLabel, roster)} type="button"><Download size={13} /> CSV</button>
                  <button className="secondary-button" disabled={!roster.length} onClick={() => printAttendance(sessionLabel, roster)} type="button"><ArrowDownToLine size={13} /> Print / PDF</button>
                </div>
              </div>
              {liveStatus && liveStatus !== 'SUBSCRIBED' && <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">{liveStatus}</p>}
              {rosterError && <div className="mt-3"><StatusNotice error>{rosterError}</StatusNotice></div>}
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="min-w-[700px] w-full text-left text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800">
                    <tr><th className="px-3 py-3">Student</th><th className="px-3 py-3">Admission no.</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Scan time</th><th className="px-3 py-3">Action</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rosterLoading ? (
                      <tr><td className="px-3 py-7 text-center text-slate-500" colSpan={5}>Loading enrolled students…</td></tr>
                    ) : roster.length ? roster.map((row) => (
                      <AttendanceRosterRow
                        key={row.student_id}
                        row={row}
                        canCorrect={selectedSession.manual_corrections_allowed}
                        onCorrect={correctAttendance}
                      />
                    )) : (
                      <tr><td className="px-3 py-7 text-center text-slate-500" colSpan={5}>No students are enrolled in this course offering.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <AttendanceAudit sessionId={selectedSession.id} refreshKey={roster.map((row) => `${row.student_id}:${row.attendance_status}:${row.marked_at ?? ''}`).join('|')} />
            </>
          )}
        </section>
      </div>

      <AttendanceReport isManager={isManager} offerings={offerings} />

      {projecting && selectedSession && visibleToken && tokenSecondsRemaining > 0 && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-white p-4 text-slate-900" role="dialog" aria-modal="true" aria-label="Projected attendance QR code">
          <button className="absolute right-4 top-4 rounded-lg p-2 text-slate-600 hover:bg-slate-100" onClick={() => setProjecting(false)} type="button" aria-label="Close projection"><X size={21} /></button>
          <div className="text-center">
            <p className="text-lg font-bold">{sessionLabel}</p>
            <p className="mt-2 text-sm text-slate-500">Scan to record your attendance · QR expires in {formatCountdown(tokenSecondsRemaining)} · session closes in {formatCountdown(sessionSecondsRemaining)}</p>
            <div className="mt-5 inline-block rounded-2xl border border-slate-200 bg-white p-5">
              <QRCodeSVG value={`STJATT:${visibleToken}`} size={Math.min(520, Math.floor(window.innerWidth * 0.62))} marginSize={5} title="Projected attendance QR code" />
            </div>
            <p className="mt-4 text-xs text-slate-500">Attendance opens {formatTanzaniaTime(selectedSession.attendance_opens_at)} · closes {formatTanzaniaTime(selectedSession.ends_at)}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function AttendanceRosterRow({
  row,
  canCorrect,
  onCorrect,
}: {
  row: RosterRow
  canCorrect: boolean
  onCorrect: (studentId: string, status: CorrectionStatus, reason: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<CorrectionStatus>(row.attendance_status === 'not_scanned' ? 'present' : row.attendance_status)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const saved = await onCorrect(row.student_id, status, reason)
    setBusy(false)
    if (saved) {
      setEditing(false)
      setReason('')
    }
  }

  return (
    <tr>
      <td className="px-3 py-3 font-medium">{row.full_name}</td>
      <td className="px-3 py-3 text-slate-500">{row.student_number}</td>
      <td className="px-3 py-3"><AttendanceStatus status={row.attendance_status} /></td>
      <td className="px-3 py-3 text-slate-500">{formatTanzaniaTime(row.marked_at)}</td>
      <td className="px-3 py-3">
        {!canCorrect ? <span className="text-[10px] text-slate-400">—</span> : editing ? (
          <form className="flex min-w-[250px] flex-col gap-2" onSubmit={submit}>
            <select className="form-input h-9" value={status} onChange={(event) => {
              const nextStatus = event.target.value
              if (nextStatus === 'present' || nextStatus === 'late' || nextStatus === 'absent' || nextStatus === 'excused') {
                setStatus(nextStatus)
              }
            }}>
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="absent">Absent</option>
              <option value="excused">Excused</option>
            </select>
            <input className="form-input h-9" minLength={5} maxLength={1000} placeholder="Reason required (min. 5 characters)" required value={reason} onChange={(event) => setReason(event.target.value)} />
            <span className="flex gap-2">
              <button className="primary-button h-8" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save correction'}</button>
              <button className="secondary-button h-8" onClick={() => setEditing(false)} type="button">Cancel</button>
            </span>
          </form>
        ) : (
          <button className="rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/30" onClick={() => setEditing(true)} type="button">Correct</button>
        )}
      </td>
    </tr>
  )
}

function StudentAttendance({ user }: { user: User }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const [scanning, setScanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [history, setHistory] = useState<StudentHistoryEntry[]>([])
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  const loadHistory = useCallback(async () => {
    if (!supabase) {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    const { data, error } = await supabase
      .from('college_attendance_records')
      .select('id,attendance_status,marked_at,session:college_attendance_sessions!inner(starts_at,course_offering_id,offering:college_course_offerings!inner(academic_year,term,section,course:college_courses(code,name)))')
      .eq('student_id', user.id)
      .order('marked_at', { ascending: false })
      .limit(100)
    if (error) {
      setIsError(true)
      setMessage(error.message)
    } else {
      setHistory((data ?? []) as unknown as StudentHistoryEntry[])
    }
    setHistoryLoading(false)
  }, [user.id])

  useEffect(() => {
    void loadHistory()
    return () => controlsRef.current?.stop()
  }, [loadHistory])

  async function submitCode(rawValue: string) {
    const match = /^STJATT:([0-9a-f]{64})$/.exec(rawValue.trim())
    if (!match) {
      setIsError(true)
      setMessage('This QR code is not a valid St James attendance code.')
      return
    }
    if (!supabase) {
      setIsError(true)
      setMessage('Supabase is not configured.')
      return
    }
    setSubmitting(true)
    setMessage('')
    const { data, error } = await supabase.rpc('submit_college_attendance_scan', {
      p_token: match[1],
    })
    setSubmitting(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    const response = data as { status?: string; marked_at?: string } | null
    setIsError(false)
    setMessage(`Attendance confirmed: ${response?.status?.replace('_', ' ') ?? 'recorded'} at ${formatTanzaniaTime(response?.marked_at)}.`)
    await loadHistory()
  }

  async function startCamera() {
    if (!videoRef.current) return
    setMessage('')
    setIsError(false)
    setScanning(true)
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      const reader = new BrowserQRCodeReader()
      const controls = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        videoRef.current,
        (result, error) => {
          if (result) {
            controlsRef.current?.stop()
            controlsRef.current = null
            setScanning(false)
            void submitCode(result.getText())
          } else if (error && !['NotFoundException', 'ChecksumException', 'FormatException'].includes(error.name)) {
            setIsError(true)
            setMessage(`Camera scan error: ${error.message}`)
          }
        },
      )
      controlsRef.current = controls
    } catch (error) {
      setScanning(false)
      setIsError(true)
      setMessage(displayError(error, 'Could not start the camera. Allow camera access and use HTTPS or localhost.'))
    }
  }

  function stopCamera() {
    controlsRef.current?.stop()
    controlsRef.current = null
    setScanning(false)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <p className="text-xs font-medium text-slate-500">Student attendance · {timeZone}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Scan attendance QR</h2>
        <p className="mt-2 text-sm text-slate-500">Your signed-in student account identifies you automatically. You never enter your name or admission number.</p>
      </div>
      {message && <div className="mt-5"><StatusNotice error={isError}>{message}</StatusNotice></div>}
      <section className="mt-6 grid gap-5 md:grid-cols-[1fr_0.85fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300"><Camera size={19} /></span>
            <div><h3 className="text-sm font-bold">Camera scanner</h3><p className="mt-1 text-[10px] text-slate-500">Point your rear camera at the lecturer’s current QR code.</p></div>
          </div>
          <div className="mt-5 overflow-hidden rounded-xl bg-slate-950">
            <video
              autoPlay
              className={`aspect-video w-full object-cover ${scanning ? 'block' : 'hidden'}`}
              muted
              playsInline
              ref={videoRef}
            />
            {!scanning && (
              <div className="grid aspect-video place-items-center text-center text-slate-400">
                <div><ScanLine className="mx-auto" size={34} /><p className="mt-2 text-xs">Camera is off</p></div>
              </div>
            )}
          </div>
          {scanning ? (
            <button className="secondary-button mt-4 w-full justify-center" onClick={stopCamera} type="button"><Square size={14} /> Stop camera</button>
          ) : (
            <button className="primary-button mt-4 h-11 w-full justify-center" disabled={submitting} onClick={() => void startCamera()} type="button">
              {submitting ? <LoaderCircle className="animate-spin" size={16} /> : <Camera size={16} />}
              {submitting ? 'Submitting attendance…' : 'Start camera scanner'}
            </button>
          )}
          <p className="mt-3 text-[10px] leading-5 text-slate-500">Camera access requires HTTPS on deployed sites. The scan is validated against your authenticated account and course enrolment on the server.</p>
        </div>
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-5 dark:border-indigo-900 dark:bg-indigo-950/25 sm:p-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-indigo-600 dark:bg-slate-900 dark:text-indigo-300"><ShieldCheck size={19} /></span>
          <h3 className="mt-4 text-sm font-bold">Secure attendance confirmation</h3>
          <ul className="mt-3 space-y-3 text-xs leading-5 text-slate-600 dark:text-slate-300">
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={14} /> Your identity comes from your signed-in Supabase session.</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={14} /> The server checks your active course enrolment and session timing.</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={14} /> Duplicate scans, expired QR tokens, and closed sessions are rejected.</li>
          </ul>
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-5 dark:border-slate-800">
          <div><h3 className="text-sm font-bold">My attendance history</h3><p className="mt-1 text-[10px] text-slate-500">Records visible only to your account.</p></div>
          <button className="secondary-button" onClick={() => void loadHistory()} type="button"><RefreshCw size={13} /> Refresh</button>
        </div>
        {historyLoading ? <LoadingLine label="Loading your attendance…" /> : history.length ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {history.map((record) => {
              const session = relatedValue(record.session)
              const offering = relatedValue(session?.offering)
              const course = relatedValue(offering?.course)
              return (
                <div key={record.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                  <div className="flex-1">
                    <p className="text-xs font-semibold">{course?.code} · {course?.name ?? 'Course session'}</p>
                    <p className="mt-1 text-[10px] text-slate-500">{formatTanzaniaTime(session?.starts_at)} · {offering?.academic_year ?? ''} · Term {offering?.term ?? ''} · Section {offering?.section ?? ''}</p>
                  </div>
                  <AttendanceStatus status={record.attendance_status} />
                  <span className="text-[10px] text-slate-500">{formatTanzaniaTime(record.marked_at)}</span>
                </div>
              )
            })}
          </div>
        ) : <p className="p-8 text-center text-xs text-slate-500">No attendance records yet.</p>}
      </section>
    </div>
  )
}

function AttendanceReport({
  isManager,
  offerings,
}: {
  isManager: boolean
  offerings: Offering[]
}) {
  const [rows, setRows] = useState<ReportRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    studentSearch: '',
    courseSearch: '',
    section: '',
    lecturerSearch: '',
    departmentSearch: '',
    academicYear: '',
    term: '',
  })

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const startAt = filters.startDate ? dateToTanzaniaStart(filters.startDate) : null
    const endAt = filters.endDate ? dateToTanzaniaStart(filters.endDate, true) : null
    if ((filters.startDate && !startAt) || (filters.endDate && !endAt)) {
      setError('Enter valid Tanzania calendar dates.')
      return
    }
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
      setError('The report start date must not be after its end date.')
      return
    }
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    setBusy(true)
    const { data, error: queryError } = await supabase.rpc('get_college_attendance_report', {
      p_start_at: startAt,
      p_end_at: endAt,
      p_student_search: filters.studentSearch.trim() || null,
      p_course_search: filters.courseSearch.trim() || null,
      p_course_offering_id: null,
      p_section: filters.section.trim() || null,
      p_lecturer_search: isManager ? filters.lecturerSearch.trim() || null : null,
      p_department_search: filters.departmentSearch.trim() || null,
      p_lecturer_id: null,
      p_department_id: null,
      p_academic_year: filters.academicYear.trim() || null,
      p_term: filters.term ? Number(filters.term) : null,
    })
    setBusy(false)
    setSearched(true)
    if (queryError) {
      setError(queryError.message)
      setRows([])
    } else {
      setRows((data ?? []) as ReportRow[])
    }
  }

  const termOptions = Array.from(new Set(offerings.map((offering) => offering.term))).sort((a, b) => a - b)

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div><p className="text-xs font-medium text-slate-500">Searchable exports</p><h3 className="mt-1 text-base font-bold">Attendance reports</h3><p className="mt-1 text-[10px] text-slate-500">Filters are applied on the server and lecturer results remain limited to assigned offerings.</p></div>
        {searched && rows.length > 0 && (
          <div className="flex gap-2">
            <button className="secondary-button" onClick={() => downloadReport(rows)} type="button"><Download size={13} /> CSV</button>
            <button className="secondary-button" onClick={() => printReport(rows)} type="button"><ArrowDownToLine size={13} /> Print / PDF</button>
          </div>
        )}
      </div>
      <form className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={search}>
        <FilterField label="From date (Tanzania)"><input className="form-input" type="date" value={filters.startDate} onChange={(event) => setFilters({ ...filters, startDate: event.target.value })} /></FilterField>
        <FilterField label="To date (Tanzania)"><input className="form-input" type="date" value={filters.endDate} onChange={(event) => setFilters({ ...filters, endDate: event.target.value })} /></FilterField>
        <FilterField label="Student name or admission no."><input className="form-input" placeholder="Search student…" value={filters.studentSearch} onChange={(event) => setFilters({ ...filters, studentSearch: event.target.value })} /></FilterField>
        <FilterField label="Course code or name"><input className="form-input" placeholder="Search course…" value={filters.courseSearch} onChange={(event) => setFilters({ ...filters, courseSearch: event.target.value })} /></FilterField>
        <FilterField label="Class / section"><input className="form-input" placeholder="e.g. A" value={filters.section} onChange={(event) => setFilters({ ...filters, section: event.target.value })} /></FilterField>
        {isManager && <FilterField label="Lecturer name"><input className="form-input" placeholder="Search lecturer…" value={filters.lecturerSearch} onChange={(event) => setFilters({ ...filters, lecturerSearch: event.target.value })} /></FilterField>}
        <FilterField label="Department"><input className="form-input" placeholder="Search department…" value={filters.departmentSearch} onChange={(event) => setFilters({ ...filters, departmentSearch: event.target.value })} /></FilterField>
        <FilterField label="Academic year"><input className="form-input" placeholder="e.g. 2026/2027" value={filters.academicYear} onChange={(event) => setFilters({ ...filters, academicYear: event.target.value })} /></FilterField>
        <FilterField label="Semester / term">
          <select className="form-input" value={filters.term} onChange={(event) => setFilters({ ...filters, term: event.target.value })}>
            <option value="">All terms</option>
            {(termOptions.length ? termOptions : [1, 2, 3]).map((term) => <option key={term} value={term}>Term {term}</option>)}
          </select>
        </FilterField>
        <button className="primary-button h-11 justify-center self-end" disabled={busy} type="submit">{busy ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={14} />} Run report</button>
      </form>
      {error && <div className="mt-4"><StatusNotice error>{error}</StatusNotice></div>}
      {searched && !error && <p className="mt-4 text-xs text-slate-500">{rows.length} attendance record(s) found.</p>}
      {searched && !error && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="min-w-[900px] w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-3">Student</th>
                <th className="px-3 py-3">Admission no.</th>
                <th className="px-3 py-3">Course / class</th>
                <th className="px-3 py-3">Lecturer / department</th>
                <th className="px-3 py-3">Academic session</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Session time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.length ? rows.map((row) => (
                <tr key={`${row.session_id}-${row.student_number}`}>
                  <td className="px-3 py-3 font-medium">{row.full_name}</td>
                  <td className="px-3 py-3 text-slate-500">{row.student_number}</td>
                  <td className="px-3 py-3">{row.course_code} · {row.course_name}<span className="block text-[10px] text-slate-500">Section {row.section}</span></td>
                  <td className="px-3 py-3">{row.lecturer_name ?? '—'}<span className="block text-[10px] text-slate-500">{row.department_name}</span></td>
                  <td className="px-3 py-3">{row.academic_year}<span className="block text-[10px] text-slate-500">Term {row.term}</span></td>
                  <td className="px-3 py-3"><AttendanceStatus status={row.attendance_status} /></td>
                  <td className="px-3 py-3 text-slate-500">{formatTanzaniaTime(row.session_start)}</td>
                </tr>
              )) : (
                <tr><td className="px-3 py-7 text-center text-slate-500" colSpan={7}>No attendance records match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function AttendanceAudit({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function loadAudit() {
      if (!supabase) {
        setError('Supabase is not configured.')
        setLoading(false)
        return
      }
      setLoading(true)
      const { data, error: queryError } = await supabase.rpc('get_college_attendance_audit', {
        p_session_id: sessionId,
      })
      if (!active) return
      if (queryError) {
        setError(queryError.message)
      } else {
        setError('')
        setRows((data ?? []) as AuditRow[])
      }
      setLoading(false)
    }
    void loadAudit()
    return () => { active = false }
  }, [refreshKey, sessionId])

  return (
    <details className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">Session audit trail</summary>
      {error ? <div className="p-3"><StatusNotice error>{error}</StatusNotice></div> : loading ? (
        <LoadingLine label="Loading audit events…" />
      ) : rows.length ? (
        <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {rows.map((row) => (
            <div className="flex flex-col gap-1 px-4 py-3 text-[10px] sm:flex-row sm:items-start sm:justify-between" key={row.id}>
              <div>
                <p className="font-semibold">{row.action.replaceAll('_', ' ')}</p>
                {(row.student_name || row.student_number) && <p className="mt-0.5 text-slate-500">{row.student_name ?? 'Student'} · {row.student_number ?? ''}</p>}
                {row.old_status !== row.new_status && <p className="mt-0.5 text-slate-500">{row.old_status ?? 'No previous status'} → {row.new_status ?? '—'}</p>}
                {row.reason && <p className="mt-1 text-slate-600 dark:text-slate-300">Reason: {row.reason}</p>}
                <p className="mt-1 text-slate-400">By {row.actor_name ?? 'authorized user'}</p>
              </div>
              <time className="shrink-0 text-slate-500">{formatTanzaniaTime(row.created_at)}</time>
            </div>
          ))}
        </div>
      ) : <p className="p-4 text-xs text-slate-500">No audit events have been recorded.</p>}
    </details>
  )
}

function DateTimeField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[10px] font-semibold">{label}</span>
      <input className="form-input px-2 text-xs" required type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} />
      <span className="mt-1 block text-[9px] text-slate-500">Africa/Dar_es_Salaam</span>
    </label>
  )
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-[10px] font-semibold">{label}</span>{children}</label>
}

function MetricCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string
  value: number
  icon?: ReactNode
  tone?: 'green' | 'amber' | 'rose'
}) {
  const toneClass = tone === 'green'
    ? 'text-emerald-700 dark:text-emerald-300'
    : tone === 'amber'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'rose'
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-slate-800 dark:text-slate-100'
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900">
      <p className={`flex items-center gap-1.5 text-lg font-bold ${toneClass}`}>{icon}{value}</p>
      <p className="mt-0.5 text-[9px] text-slate-500">{label}</p>
    </div>
  )
}

function AttendanceStatus({ status }: { status: string }) {
  const className = status === 'present'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : status === 'late'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : status === 'absent'
        ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
        : status === 'excused'
          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  return <span className={`inline-flex w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold capitalize ${className}`}>{status.replaceAll('_', ' ')}</span>
}

function LoadingLine({ label }: { label: string }) {
  return <p className="flex items-center justify-center gap-2 p-8 text-xs text-slate-500"><LoaderCircle className="animate-spin" size={14} />{label}</p>
}

function offeringLabel(offering: Offering) {
  const course = relatedValue(offering.course)
  return `${course?.code ?? 'Course'} · ${course?.name ?? 'Untitled'} · ${offering.academic_year} · Term ${offering.term} · Section ${offering.section}`
}

function slotLabel(slot: TimetableSlot) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return `${days[slot.day_of_week - 1] ?? 'Day'} ${slot.starts_at.slice(0, 5)}–${slot.ends_at.slice(0, 5)}${slot.room ? ` · ${slot.room}` : ''}`
}

function downloadRoster(title: string, roster: RosterRow[]) {
  const rows = roster.map((row) => ({
    'Student name': row.full_name,
    'Admission number': row.student_number,
    Status: row.attendance_status,
    'Scan time (Africa/Dar_es_Salaam)': formatTanzaniaTime(row.marked_at),
    Session: title,
  }))
  downloadCsv(`attendance-${new Date().toISOString().slice(0, 10)}.csv`, rows)
}

function downloadReport(rows: ReportRow[]) {
  downloadCsv('college-attendance-report.csv', rows.map((row) => ({
    'Student name': row.full_name,
    'Admission number': row.student_number,
    Course: `${row.course_code} ${row.course_name}`,
    Class: row.section,
    Lecturer: row.lecturer_name ?? '',
    Department: row.department_name,
    'Academic year': row.academic_year,
    Term: row.term,
    Status: row.attendance_status,
    'Session date (Africa/Dar_es_Salaam)': formatTanzaniaTime(row.session_start),
    'Recorded at (Africa/Dar_es_Salaam)': formatTanzaniaTime(row.marked_at),
  })))
}

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (!rows.length) return
  const columns = Object.keys(rows[0])
  const cell = (value: string | number) => {
    const text = String(value ?? '')
    const safeText = /^[=+\-@]/.test(text.trim()) ? `'${text}` : text
    return `"${safeText.replaceAll('"', '""')}"`
  }
  const csv = `\uFEFF${[columns, ...rows.map((row) => columns.map((column) => row[column] ?? ''))].map((line) => line.map(cell).join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function printAttendance(title: string, roster: RosterRow[]) {
  printTable(title, ['Student name', 'Admission number', 'Status', 'Scan time'], roster.map((row) => [
    row.full_name,
    row.student_number,
    row.attendance_status,
    formatTanzaniaTime(row.marked_at),
  ]))
}

function printReport(rows: ReportRow[]) {
  printTable('College attendance report', ['Student', 'Admission no.', 'Course', 'Class', 'Lecturer', 'Department', 'Year / term', 'Status', 'Session time'], rows.map((row) => [
    row.full_name,
    row.student_number,
    `${row.course_code} ${row.course_name}`,
    row.section,
    row.lecturer_name ?? '',
    row.department_name,
    `${row.academic_year} / ${row.term}`,
    row.attendance_status,
    formatTanzaniaTime(row.session_start),
  ]))
}

function printTable(title: string, headings: string[], rows: string[][]) {
  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    window.alert('Allow pop-ups to print or save this attendance report as a PDF.')
    return
  }
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  printWindow.document.write(`<!doctype html><html><head><title>${escape(title)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#0f172a}h1{font-size:20px}p{color:#64748b;font-size:12px}table{border-collapse:collapse;width:100%;font-size:10px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left}th{background:#f1f5f9}</style></head><body><h1>${escape(title)}</h1><p>Generated ${escape(formatTanzaniaTime(new Date()))} · Africa/Dar_es_Salaam</p><table><thead><tr>${headings.map((heading) => `<th>${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`)
  printWindow.document.close()
  printWindow.focus()
  printWindow.print()
}
