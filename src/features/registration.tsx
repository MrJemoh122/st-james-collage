import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { CheckCircle2, FileText, ImagePlus, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { parseStudyYears } from '../lib/studyYears'
import { collegeLogoUrl } from '../lib/branding'

const bucket = 'college-applications'
const maxFileSize = 10 * 1024 * 1024
const imageTypes = ['image/jpeg', 'image/png', 'image/webp']
const documentTypes = [...imageTypes, 'application/pdf']

export type CollegeRole =
  | 'pending'
  | 'super_admin'
  | 'college_admin'
  | 'academic_registrar'
  | 'department_head'
  | 'lecturer'
  | 'student'
  | 'finance_accountant'
  | 'bursar'
  | 'librarian'
  | 'examination_officer'
  | 'non_teaching_staff'

export const registrationAdminRoles: CollegeRole[] = [
  'super_admin',
  'college_admin',
  'academic_registrar',
]

type Props = { user: User; onRefresh?: () => void }
type Department = { id: string; code: string; name: string; is_active: boolean }
type DepartmentSubject = {
  id: string
  department_id: string
  code: string
  name: string
  credit_hours: number
  is_active: boolean
  study_years: number[]
}
type QualificationOfferingChoice = {
  id: string
  department_id: string
  name: string
  is_active: boolean
  application_open: boolean
}
type ApplicationFile = { file: File; type: string }
type Related<T> = T | T[] | null
type StudentDirectoryEntry = {
  id: string
  student_number: string
  student_status: string
  study_year: number | null
  phone: string | null
  photo_path: string | null
  photoUrl?: string
  profile: Related<{ full_name: string | null; email: string | null }>
  department: Related<{ id: string; code: string; name: string }>
  qualification: Related<{ id: string; name: string; department_id: string }>
}
type StaffDirectoryEntry = {
  id: string
  staff_number: string
  department_id?: string
  job_title: string | null
  employment_status: string
  photo_path: string | null
  photoUrl?: string
  profile: Related<{ full_name: string | null; email: string | null; role: string }>
  department: Related<{ name: string }>
}
type UploadedDocument = {
  path: string
  name: string
  type: string
}

function relationValue<T>(value: Related<T> | undefined) {
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
  return 'Student application could not be submitted.'
}

function isAllowedPhoto(file: File) {
  return file.size > 0 && file.size <= maxFileSize && imageTypes.includes(file.type)
}

function isAllowedDocument(file: File) {
  return file.size > 0 && file.size <= maxFileSize && documentTypes.includes(file.type)
}

function safeFileName(name: string) {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'upload'
}

async function uploadFile(userId: string, subject: 'student' | 'staff', kind: 'photo' | 'documents', file: File) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const path = `applications/${userId}/${subject}/${kind}/${crypto.randomUUID()}-${safeFileName(file.name)}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  })
  if (error) throw error
  return path
}

async function matchesFileSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (file.type === 'application/pdf') {
    return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
  }
  if (file.type === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (file.type === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  }
  if (file.type === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  }
  return false
}

function FormMessage({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return null
  return (
    <p
      aria-live="polite"
      className={`rounded-xl px-3 py-2.5 text-xs leading-5 ${
        error
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      }`}
    >
      {message}
    </p>
  )
}

function FileField({
  label,
  accept,
  required = false,
  file,
  onChange,
  hint,
}: {
  label: string
  accept: string
  required?: boolean
  file: File | null
  onChange: (file: File | null) => void
  hint: string
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold">
        {label}{required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      <span className="flex min-h-12 items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
        <ImagePlus className="shrink-0 text-slate-400" size={17} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{file?.name ?? 'Choose a file'}</span>
          <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span>
        </span>
        <input
          accept={accept}
          className="sr-only"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
          required={required && !file}
          type="file"
        />
      </span>
    </label>
  )
}

export function ApplicantPortal({ user, onRefresh }: Props) {
  const [loading, setLoading] = useState(true)
  const [existing, setExisting] = useState<{ kind: 'student' | 'staff'; status: string } | null>(null)
  const [loadError, setLoadError] = useState('')

  const loadApplication = useCallback(async () => {
    if (!supabase) {
      setLoadError('Supabase is not configured.')
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    const [studentResult, staffResult] = await Promise.all([
      supabase
        .from('college_student_applications')
        .select('application_status')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase
        .from('college_staff_applications')
        .select('application_status')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])
    const error = studentResult.error ?? staffResult.error
    if (error) {
      setLoadError(error.message)
      setExisting(null)
    } else if (studentResult.data) {
      setExisting({ kind: 'student', status: studentResult.data.application_status })
    } else if (staffResult.data) {
      setExisting({ kind: 'staff', status: staffResult.data.application_status })
    } else {
      setExisting(null)
    }
    setLoading(false)
  }, [user.id])

  useEffect(() => {
    void loadApplication()
  }, [loadApplication])

  if (loading) {
    return <LoadingCard label="Checking your application…" />
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] px-4 py-8 dark:bg-slate-950 sm:px-7 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <img alt="St James College crest" className="h-11 w-11 shrink-0 rounded-lg bg-white object-contain p-0.5" src={collegeLogoUrl} />
            <div>
              <p className="text-sm font-bold">St James College</p>
              <p className="text-xs text-slate-500">Applicant portal</p>
            </div>
          </div>
          <button
            className="secondary-button w-fit"
            onClick={async () => {
              const { error } = await supabase!.auth.signOut()
              if (error) setLoadError(`Could not sign out: ${error.message}`)
            }}
          >
            Sign out
          </button>
        </header>

        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
            Registration
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Complete your application</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Signed in as {user.email}. Your account stays pending until the college reviews your application.
          </p>
          <div className="mt-5 rounded-xl border border-indigo-100 bg-indigo-50/70 p-4 text-xs leading-5 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-200">
            <span className="flex items-center gap-2 font-semibold"><ShieldCheck size={16} /> Private uploads</span>
            <span className="mt-1 block">Photos and documents are stored in a private bucket and visible only to you and authorized registrars.</span>
          </div>

          {loadError && <div className="mt-5"><FormMessage error message={loadError} /></div>}

          {existing ? (
            <div className="mt-6 rounded-xl border border-slate-200 p-5 dark:border-slate-700">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 text-indigo-600" size={19} />
                <div>
                  <p className="text-sm font-semibold">
                    {existing.kind === 'student' ? 'Student' : 'Staff'} application {existing.status}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {existing.kind === 'staff'
                      ? 'Staff accounts are now created by the college administrator. Contact the administrator if you need staff access.'
                      : existing.status === 'approved'
                        ? 'Your account has been approved. Sign out and sign in again to refresh your role.'
                        : 'The registrar will review your details and documents. Your account remains restricted while review is pending.'}
                  </p>
                </div>
              </div>
              <button
                className="secondary-button mt-4"
                onClick={() => {
                  void loadApplication()
                  onRefresh?.()
                }}
              >
                <RefreshCw size={14} /> Refresh status
              </button>
            </div>
          ) : (
            <div className="mt-6">
              <StudentApplicationForm user={user} onSubmitted={loadApplication} />
              <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800">
                Lecturer and non-teaching staff accounts are created by an administrator and activated through a secure email invitation.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

function StudentApplicationForm({ user, onSubmitted }: Props & { onSubmitted: () => Promise<void> }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [offerings, setOfferings] = useState<QualificationOfferingChoice[]>([])
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [photo, setPhoto] = useState<File | null>(null)
  const [identity, setIdentity] = useState<File | null>(null)
  const [certificate, setCertificate] = useState<File | null>(null)
  const [otherDocuments, setOtherDocuments] = useState<File[]>([])
  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    address: '',
    emergencyName: '',
    emergencyPhone: '',
    departmentId: '',
    qualificationOfferingIds: [] as string[],
  })

  useEffect(() => {
    if (!supabase) return
    let active = true
    void Promise.all([
      supabase.from('college_departments').select('id,code,name,is_active').eq('is_active', true).order('name'),
      supabase
        .from('college_qualification_offerings')
        .select('id,department_id,name,is_active,application_open')
        .eq('is_active', true)
        .eq('application_open', true)
        .order('name'),
      supabase.from('college_qualification_subjects').select('qualification_offering_id'),
    ]).then(([departmentResult, offeringResult, subjectResult]) => {
      if (!active) return
      const error = departmentResult.error ?? offeringResult.error ?? subjectResult.error
      if (error) {
        setLoadError(error.message)
        return
      }
      setDepartments(departmentResult.data ?? [])
      const offeringsWithSubjects = new Set((subjectResult.data ?? []).map((subject) => subject.qualification_offering_id))
      setOfferings(((offeringResult.data ?? []) as QualificationOfferingChoice[])
        .filter((offering) => offeringsWithSubjects.has(offering.id)))
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : 'Could not load active departments and course offerings.')
    })
    return () => { active = false }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    if (!supabase) return showError('Supabase is not configured.')
    if (form.fullName.trim().length < 3) return showError('Enter your full legal name (at least 3 characters).')
    if (form.phone.trim().length < 5) return showError('Enter a valid phone number.')
    if (!form.dateOfBirth || form.dateOfBirth >= new Date().toISOString().slice(0, 10)) {
      return showError('Enter a valid date of birth in the past.')
    }
    if (!['female', 'male', 'other', 'prefer_not_to_say'].includes(form.gender)) {
      return showError('Choose a gender option.')
    }
    if (form.emergencyName.trim().length < 2) return showError('Enter an emergency contact name.')
    if (form.emergencyPhone.trim().length < 5) return showError('Enter a valid emergency contact phone number.')
    if (!form.departmentId) return showError('Choose a department.')
    if (form.address.trim().length < 5) return showError('Enter your home address (at least 5 characters).')
    if (!photo || !identity || !certificate) return showError('Add a photo, identity document, and academic certificate.')
    if (form.qualificationOfferingIds.length < 1) return showError('Choose at least one course offering preference.')
    if (form.qualificationOfferingIds.some((id) => !offerings.some((offering) =>
      offering.id === id && offering.department_id === form.departmentId))) {
      return showError('Choose course offerings from your selected department only.')
    }
    if (otherDocuments.length > 6) return showError('You can upload up to six additional documents.')
    if (!isAllowedPhoto(photo)) return showError('Photo must be a JPEG, PNG, or WebP image no larger than 10 MB.')
    const documents: ApplicationFile[] = [
      { file: identity, type: 'identity' },
      { file: certificate, type: 'certificate' },
      ...otherDocuments.map((file) => ({ file, type: 'other' })),
    ]
    if (documents.some(({ file }) => !isAllowedDocument(file))) {
      return showError('Documents must be PDF, JPEG, PNG, or WebP and no larger than 10 MB each.')
    }
    if (documents.length > 8) return showError('Upload no more than eight documents.')

    setBusy(true)
    const uploaded: string[] = []
    try {
      let photoSignatureMatches: boolean
      try {
        photoSignatureMatches = await matchesFileSignature(photo)
      } catch {
        throw new Error('Could not read the selected photo. Please choose it again.')
      }
      if (!photoSignatureMatches) throw new Error('The selected photo does not match its file type.')

      let documentSignaturesMatch: boolean
      try {
        documentSignaturesMatch = (await Promise.all(documents.map(({ file }) => matchesFileSignature(file)))).every(Boolean)
      } catch {
        throw new Error('Could not read the selected documents. Please choose them again.')
      }
      if (!documentSignaturesMatch) throw new Error('One or more documents do not match their file type.')

      const photoPath = await uploadFile(user.id, 'student', 'photo', photo)
      uploaded.push(photoPath)
      const uploadedDocuments: UploadedDocument[] = []
      for (const document of documents) {
        const path = await uploadFile(user.id, 'student', 'documents', document.file)
        uploaded.push(path)
        uploadedDocuments.push({ path, name: document.file.name, type: document.type })
      }

      const { error } = await supabase.rpc('submit_college_student_application_with_qualification_preferences', {
        p_department_id: form.departmentId,
        p_full_name: form.fullName,
        p_phone: form.phone,
        p_date_of_birth: form.dateOfBirth,
        p_gender: form.gender,
        p_home_address: form.address,
        p_emergency_contact_name: form.emergencyName,
        p_emergency_contact_phone: form.emergencyPhone,
        p_photo_path: photoPath,
        p_documents: uploadedDocuments,
        p_qualification_offering_ids: form.qualificationOfferingIds,
      })
      if (error) throw error
      setMessage('Application submitted. Your account will remain pending until the registrar reviews it.')
      await onSubmitted()
    } catch (error) {
      let cleanupMessage = ''
      if (uploaded.length) {
        try {
          const cleanup = await supabase.storage.from(bucket).remove(uploaded)
          if (cleanup.error) cleanupMessage = ` Uploaded files need cleanup: ${cleanup.error.message}`
        } catch (cleanupError) {
          cleanupMessage = ` Uploaded files need cleanup: ${messageOf(cleanupError)}`
        }
      }
      showError(`${messageOf(error)}${cleanupMessage}`)
    } finally {
      setBusy(false)
    }
  }

  function showError(text: string) {
    setIsError(true)
    setMessage(text)
  }

  if (loadError) return <FormMessage error message={`Could not load course offerings: ${loadError}`} />

  const departmentOfferings = offerings.filter((offering) =>
    offering.department_id === form.departmentId,
  )

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full legal name" required>
          <input className="form-input" autoComplete="name" maxLength={120} required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </Field>
        <Field label="Phone number" required>
          <input className="form-input" autoComplete="tel" maxLength={30} required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Date of birth" required>
          <input className="form-input" max={new Date().toISOString().slice(0, 10)} required type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
        </Field>
        <Field label="Gender" required>
          <select className="form-input" required value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">Select</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
            <option value="prefer_not_to_say">Prefer not to say</option>
          </select>
        </Field>
        <Field label="Emergency contact name" required>
          <input className="form-input" maxLength={120} required value={form.emergencyName} onChange={(e) => setForm({ ...form, emergencyName: e.target.value })} />
        </Field>
        <Field label="Emergency contact phone" required>
          <input className="form-input" maxLength={30} required type="tel" value={form.emergencyPhone} onChange={(e) => setForm({ ...form, emergencyPhone: e.target.value })} />
        </Field>
        <Field label="Department" required>
          <select className="form-input" required value={form.departmentId} onChange={(e) => setForm({
            ...form,
            departmentId: e.target.value,
            qualificationOfferingIds: [],
          })}>
            <option value="">Choose department</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.code} · {department.name}</option>)}
          </select>
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold">Choose course-offering preferences <span className="text-rose-500">*</span></legend>
        <p className="text-[11px] leading-5 text-slate-500">Choose the qualifications you want to apply for, in preference order. The registrar will admit you to one offering and assign your year of study.</p>
        {departmentOfferings.length ? <div className="grid gap-2 sm:grid-cols-2">{departmentOfferings.map((offering) => {
          const checked = form.qualificationOfferingIds.includes(offering.id)
          const preference = form.qualificationOfferingIds.indexOf(offering.id) + 1
          return <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-xs ${checked ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-700'}`} key={offering.id}>
            <input checked={checked} onChange={(event) => setForm({
              ...form,
              qualificationOfferingIds: event.target.checked
                ? [...form.qualificationOfferingIds, offering.id]
                : form.qualificationOfferingIds.filter((id) => id !== offering.id),
            })} type="checkbox" />
            <span><span className="block font-semibold">{offering.name}</span><span className="mt-1 block text-slate-500">{checked ? `Preference ${preference}` : 'Available course offering'}</span></span>
          </label>
        })}</div> : <p className="rounded-xl border border-dashed border-slate-300 p-4 text-xs text-slate-500 dark:border-slate-700">{form.departmentId ? 'No course offerings are currently open for applications in this department. Contact the registrar.' : 'Choose a department to view its open course offerings.'}</p>}
      </fieldset>
      <Field label="Home address" required>
        <textarea className="form-input min-h-20 resize-y py-3" maxLength={500} required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <FileField label="Passport-style photo" accept="image/jpeg,image/png,image/webp" file={photo} onChange={setPhoto} required hint="JPEG, PNG, WebP · up to 10 MB" />
        <FileField label="Identity document" accept=".pdf,image/jpeg,image/png,image/webp" file={identity} onChange={setIdentity} required hint="PDF or image · up to 10 MB" />
        <FileField label="Academic certificate" accept=".pdf,image/jpeg,image/png,image/webp" file={certificate} onChange={setCertificate} required hint="PDF or image · up to 10 MB" />
        <label className="block">
          <span className="mb-2 block text-xs font-semibold">Additional documents <span className="font-normal text-slate-500">(optional, up to 6)</span></span>
          <span className="flex min-h-12 items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
            <FileText className="shrink-0 text-slate-400" size={17} />
            <span className="min-w-0 flex-1 truncate text-xs">{otherDocuments.length ? `${otherDocuments.length} file(s) selected` : 'Choose files'}</span>
            <input
              accept=".pdf,image/jpeg,image/png,image/webp"
              className="sr-only"
              multiple
              onChange={(e) => setOtherDocuments(Array.from(e.target.files ?? []))}
              type="file"
            />
          </span>
        </label>
      </div>
      {loadError && <FormMessage error message={loadError} />}
      <FormMessage error={isError} message={message} />
      <button className="primary-button h-11 w-full justify-center sm:w-auto" disabled={busy || departments.length === 0} type="submit">
        {busy ? <><LoaderCircle className="animate-spin" size={16} /> Uploading application…</> : 'Submit student application'}
      </button>
      {departments.length === 0 && <p className="text-xs text-slate-500">Applications open when an administrator activates a department.</p>}
    </form>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold">{label}{required && <span className="ml-1 text-rose-500">*</span>}</span>
      {children}
    </label>
  )
}

export function DepartmentsPage({
  canManage,
  canDelete,
  role,
  userId,
}: {
  canManage: boolean
  canDelete: boolean
  role: CollegeRole
  userId: string
}) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [subjects, setSubjects] = useState<DepartmentSubject[]>([])
  const [ownDepartmentId, setOwnDepartmentId] = useState('')
  const [subjectDrafts, setSubjectDrafts] = useState<Record<string, { code: string; name: string; creditHours: string; studyYears: string }>>({})
  const [subjectYearDrafts, setSubjectYearDrafts] = useState<Record<string, string>>({})
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const canManageSubjects = canManage || role === 'department_head'

  const loadDepartments = useCallback(async () => {
    if (!supabase) return false
    setLoading(true)
    const [departmentResult, subjectResult, subjectYearResult, staffResult] = await Promise.all([
      supabase.from('college_departments').select('id,code,name,is_active').order('name'),
      supabase.from('college_courses').select('id,department_id,code,name,credit_hours,is_active').order('code'),
      supabase.from('college_course_study_years').select('course_id,study_year').order('study_year'),
      role === 'department_head'
        ? supabase.from('college_staff').select('department_id').eq('id', userId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    const error = departmentResult.error ?? subjectResult.error ?? subjectYearResult.error ?? staffResult.error
    if (error) {
      setIsError(true)
      setMessage(error.message)
      setLoading(false)
      return false
    }
    const departmentId = staffResult.data?.department_id ?? ''
    const allDepartments = departmentResult.data ?? []
    const studyYearsByCourse = new Map<string, number[]>()
    for (const assignment of subjectYearResult.data ?? []) {
      const years = studyYearsByCourse.get(assignment.course_id) ?? []
      years.push(Number(assignment.study_year))
      studyYearsByCourse.set(assignment.course_id, years)
    }
    setOwnDepartmentId(departmentId)
    setDepartments(role === 'department_head' && departmentId
      ? allDepartments.filter((department) => department.id === departmentId)
      : allDepartments)
    setSubjects((subjectResult.data ?? []).map((subject) => ({
      ...subject,
      study_years: studyYearsByCourse.get(subject.id) ?? [],
    })))
    setMessage('')
    setLoading(false)
    return true
  }, [role, userId])

  useEffect(() => {
    void loadDepartments()
  }, [loadDepartments])

  async function addDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const departmentCode = code.trim().toUpperCase()
    const departmentName = name.trim()
    if (!departmentCode || !departmentName) {
      setIsError(true)
      setMessage('Enter both a department code and department name.')
      return
    }
    if (!supabase) {
      setIsError(true)
      setMessage('Supabase is not configured.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const { error } = await supabase.from('college_departments').insert({
        code: departmentCode,
        name: departmentName,
      })
      if (error) {
        setIsError(true)
        let errorMessage = error.message
        if (error.code === '23505') {
          if (error.message.includes('college_departments_code_key')) {
            errorMessage = `Department code "${departmentCode}" already exists. Choose a different code.`
          } else if (error.message.includes('college_departments_name_key')) {
            errorMessage = `Department name "${departmentName}" already exists. Choose a different name.`
          } else {
            errorMessage = 'A department with that code or name already exists. Choose unique values.'
          }
        } else if (error.code === '42501') {
          errorMessage = `Your account is not permitted to create departments. ${error.message}`
        }
        setMessage(errorMessage)
        return
      }
      setCode('')
      setName('')
      if (await loadDepartments()) {
        setIsError(false)
        setMessage('Department created.')
      }
    } catch (caught) {
      setIsError(true)
      setMessage(caught instanceof Error
        ? caught.message
        : caught && typeof caught === 'object' && 'message' in caught && typeof caught.message === 'string'
          ? caught.message
          : 'The department could not be created. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(department: Department) {
    if (!supabase || !canManage) return
    const { error } = await supabase
      .from('college_departments')
      .update({ is_active: !department.is_active })
      .eq('id', department.id)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setIsError(false)
    setMessage(`Department ${department.is_active ? 'deactivated' : 'activated'}.`)
    await loadDepartments()
  }

  async function addSubject(event: FormEvent<HTMLFormElement>, department: Department) {
    event.preventDefault()
    if (!supabase || !canManageSubjects) return
    if (role === 'department_head' && department.id !== ownDepartmentId) {
      setIsError(true)
      setMessage('You can only add subjects to your assigned department.')
      return
    }
    const draft = subjectDrafts[department.id] ?? { code: '', name: '', creditHours: '1', studyYears: '1' }
    const subjectCode = draft.code.trim().toUpperCase()
    const subjectName = draft.name.trim()
    const creditHours = Number(draft.creditHours)
    const studyYears = parseStudyYears(draft.studyYears)
    if (!subjectCode || !subjectName || !Number.isInteger(creditHours) || creditHours < 1
      || !studyYears?.length) {
      setIsError(true)
      setMessage('Enter a subject code, name, valid credit hours, and at least one study year from 1 to 20.')
      return
    }

    setBusy(true)
    setMessage('')
    const { data: createdSubject, error } = await supabase.from('college_courses').insert({
      department_id: department.id,
      code: subjectCode,
      name: subjectName,
      credit_hours: creditHours,
    }).select('id').single()
    if (error) {
      setBusy(false)
      setIsError(true)
      setMessage(error.code === '23505'
        ? `Subject code "${subjectCode}" already exists. Choose a unique code.`
        : error.message)
      return
    }
    const { error: yearError } = await supabase.rpc('set_college_course_study_years', {
      p_course_id: createdSubject.id,
      p_study_years: studyYears,
    })
    setBusy(false)
    if (yearError) {
      setIsError(true)
      setMessage(`Subject created, but study-year assignment failed: ${yearError.message}`)
      await loadDepartments()
      return
    }
    setSubjectDrafts((current) => ({ ...current, [department.id]: { code: '', name: '', creditHours: '1', studyYears: '1' } }))
    setIsError(false)
    setMessage(`Subject added to ${department.name} for year${studyYears.length === 1 ? '' : 's'} ${studyYears.join(', ')}.`)
    await loadDepartments()
  }

  async function saveSubjectYears(subject: DepartmentSubject) {
    if (!supabase || !canManageSubjects) return
    if (role === 'department_head' && subject.department_id !== ownDepartmentId) {
      setIsError(true)
      setMessage('You can only assign study years to subjects in your assigned department.')
      return
    }
    const years = parseStudyYears(subjectYearDrafts[subject.id] ?? subject.study_years.join(', '))
    if (!years) {
      setIsError(true)
      setMessage('Enter unique study years from 1 to 20, separated by commas.')
      return
    }
    setBusy(true)
    setMessage('')
    const { error } = await supabase.rpc('set_college_course_study_years', {
      p_course_id: subject.id,
      p_study_years: years,
    })
    setBusy(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    await loadDepartments()
    setIsError(false)
    setMessage(years.length
      ? `Study years updated for ${subject.code}.`
      : `${subject.code} is hidden from students until study years are assigned.`)
  }

  async function deleteSubject(subject: DepartmentSubject) {
    if (!supabase || !canManageSubjects) return
    if (role === 'department_head' && subject.department_id !== ownDepartmentId) {
      setIsError(true)
      setMessage('You can only delete subjects in your assigned department.')
      return
    }
    if (!window.confirm(`Delete subject "${subject.code} · ${subject.name}"? This cannot be undone.`)) return

    setBusy(true)
    setMessage('')
    const { data, error } = await supabase
      .from('college_courses')
      .delete()
      .eq('id', subject.id)
      .select('id')
    setBusy(false)
    if (error) {
      setIsError(true)
      setMessage(error.code === '23503'
        ? 'This subject is used by course offerings, course-offering subject assignments, or academic records and cannot be deleted. Deactivate it instead.'
        : error.message)
      return
    }
    if (!data?.length) {
      setIsError(true)
      setMessage('The subject was not found or your account is not permitted to delete it.')
      return
    }
    setIsError(false)
    setMessage(`Subject ${subject.code} deleted.`)
    await loadDepartments()
  }

  async function deleteDepartment(department: Department) {
    if (!supabase || !canDelete) return
    const confirmed = window.confirm(
      `Delete department "${department.name}" (${department.code})? This cannot be undone. Departments linked to other records cannot be deleted.`,
    )
    if (!confirmed) return

    setBusy(true)
    setMessage('')
    try {
      const { error } = await supabase
        .from('college_departments')
        .delete()
        .eq('id', department.id)
      if (error) {
        setIsError(true)
        setMessage(error.code === '23503'
          ? 'This department is linked to other records and cannot be deleted. Deactivate it instead.'
          : error.code === '42501'
            ? `Your account is not permitted to delete departments. ${error.message}`
            : error.message)
        return
      }
      if (await loadDepartments()) {
        setIsError(false)
        setMessage('Department deleted.')
      }
    } catch (caught) {
      setIsError(true)
      setMessage(caught instanceof Error
        ? caught.message
        : 'The department could not be deleted. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <p className="text-xs font-medium text-slate-500">Academic structure</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Departments</h2>
        <p className="mt-2 text-sm text-slate-500">Assign each subject to study years. Students see active subjects assigned to their department and current year.</p>
      </div>
      {canManage && (
        <form className="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end dark:border-slate-800 dark:bg-slate-900" onSubmit={addDepartment}>
          <Field label="Department code" required>
            <input className="form-input uppercase" maxLength={16} required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Department name" required>
            <input className="form-input" maxLength={120} required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button className="primary-button h-11 justify-center" disabled={busy} type="submit">
            <Plus size={16} /> {busy ? 'Saving…' : 'Add department'}
          </button>
        </form>
      )}
      <div className="mt-5"><FormMessage error={isError} message={message} /></div>
      {loading ? <LoadingCard label="Loading departments…" /> : departments.length ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {departments.map((department) => {
            const departmentSubjects = subjects.filter((subject) => subject.department_id === department.id)
            const draft = subjectDrafts[department.id] ?? { code: '', name: '', creditHours: '1', studyYears: '1' }
            return (
              <section key={department.id} className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <header className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold">{department.code} · {department.name}</h3>
                    <p className="mt-1 text-xs text-slate-500">{departmentSubjects.length} subject{departmentSubjects.length === 1 ? '' : 's'}</p>
                  </div>
                  <span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold ${department.is_active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                    {department.is_active ? 'Active' : 'Inactive'}
                  </span>
                  {canManage && (
                    <button className="secondary-button justify-center" disabled={busy} onClick={() => void toggleActive(department)} type="button">
                      {department.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                  {canDelete && (
                    <button className="secondary-button justify-center text-rose-600" disabled={busy} onClick={() => void deleteDepartment(department)} type="button">
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                </header>

                <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
                  {departmentSubjects.length ? departmentSubjects.map((subject) => (
                    <div key={subject.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{subject.code} · {subject.name}</p>
                        <p className="mt-1 text-[10px] text-slate-500">{subject.credit_hours} credit hours · {subject.is_active ? 'Active' : 'Inactive'} · {subject.study_years.length ? `Years ${subject.study_years.join(', ')}` : 'No study years assigned'}</p>
                      </div>
                      {canManageSubjects && (
                        <div className="flex items-end gap-2">
                          <Field label="Study years">
                            <input
                              className="form-input w-32"
                              aria-label={`Study years for ${subject.code}`}
                              placeholder="1, 2"
                              value={subjectYearDrafts[subject.id] ?? subject.study_years.join(', ')}
                              onChange={(event) => setSubjectYearDrafts((current) => ({
                                ...current,
                                [subject.id]: event.target.value,
                              }))}
                            />
                          </Field>
                          <button
                            className="secondary-button justify-center"
                            disabled={busy}
                            onClick={() => void saveSubjectYears(subject)}
                            type="button"
                          >
                            Save
                          </button>
                        </div>
                      )}
                      {canManageSubjects && (
                        <button
                          aria-label={`Delete ${subject.code} ${subject.name}`}
                          className="secondary-button justify-center text-rose-600"
                          disabled={busy}
                          onClick={() => void deleteSubject(subject)}
                          type="button"
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      )}
                    </div>
                  )) : <p className="py-4 text-xs text-slate-500">No subjects have been added to this department.</p>}
                </div>

                {canManageSubjects && (
                  <form className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1.5fr_90px_1fr_auto] sm:items-end dark:border-slate-800" onSubmit={(event) => void addSubject(event, department)}>
                    <Field label="Subject code" required>
                      <input className="form-input uppercase" maxLength={40} required value={draft.code} onChange={(event) => setSubjectDrafts((current) => ({
                        ...current,
                        [department.id]: { ...draft, code: event.target.value },
                      }))} />
                    </Field>
                    <Field label="Subject name" required>
                      <input className="form-input" maxLength={160} required value={draft.name} onChange={(event) => setSubjectDrafts((current) => ({
                        ...current,
                        [department.id]: { ...draft, name: event.target.value },
                      }))} />
                    </Field>
                    <Field label="Credits" required>
                      <input className="form-input" max="100" min="1" required type="number" value={draft.creditHours} onChange={(event) => setSubjectDrafts((current) => ({
                        ...current,
                        [department.id]: { ...draft, creditHours: event.target.value },
                      }))} />
                    </Field>
                    <Field label="Study years" required>
                      <input className="form-input" maxLength={60} placeholder="1, 2" required value={draft.studyYears} onChange={(event) => setSubjectDrafts((current) => ({
                        ...current,
                        [department.id]: { ...draft, studyYears: event.target.value },
                      }))} />
                    </Field>
                    <button className="primary-button h-10 justify-center" disabled={busy} type="submit">
                      <Plus size={14} /> Add subject
                    </button>
                  </form>
                )}
              </section>
            )
          })}
        </div>
      ) : <p className="mt-4 rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
        {role === 'department_head' && !ownDepartmentId ? 'No department is assigned to your account.' : 'No departments yet.'}
      </p>}
    </div>
  )
}

type ApplicationDocument = {
  id: string
  document_type: string
  original_name: string
  storage_path: string
}

type StudentApplication = {
  id: string
  department_id: string | null
  full_name: string
  phone: string
  date_of_birth: string
  gender: string
  home_address: string
  emergency_contact_name: string
  emergency_contact_phone: string
  photo_path: string
  study_year: number | null
  selected_qualification_offering_id: string | null
  submitted_at: string
  department?: { id: string; code: string; name: string } | null
  qualification_choices?: Array<{
    preference_order: number
    qualification: Related<{ id: string; name: string; is_active: boolean }>
  }>
  course_choices?: Array<{
    offering: Related<{
      academic_year: string
      term: number
      section: string
      course: Related<{ code: string; name: string }>
    }>
  }>
  documents?: ApplicationDocument[]
  photoUrl?: string
  documentUrls?: Record<string, string>
}

type StaffApplication = {
  id: string
  staff_type: string
  full_name: string
  phone: string
  job_title: string
  highest_qualification: string
  years_experience: number
  photo_path: string
  submitted_at: string
  department?: { name: string } | null
  documents?: ApplicationDocument[]
  photoUrl?: string
  documentUrls?: Record<string, string>
}

export function RegistrationReviewPage() {
  const [students, setStudents] = useState<StudentApplication[]>([])
  const [staff, setStaff] = useState<StaffApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [savingPlacementId, setSavingPlacementId] = useState('')
  const [placementDrafts, setPlacementDrafts] = useState<Record<string, {
    departmentId: string
    studyYear: string
    qualificationOfferingId: string
  }>>({})
  const [departments, setDepartments] = useState<Department[]>([])
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  const loadApplications = useCallback(async () => {
    const client = supabase
    if (!client) return
    setLoading(true)
    const [studentResult, staffResult, departmentResult] = await Promise.all([
      client
        .from('college_student_applications')
        .select('*, department:college_departments(id,code,name), qualification_choices:college_student_application_qualification_choices(preference_order,qualification:college_qualification_offerings(id,name,is_active)), course_choices:college_student_application_course_choices(offering:college_course_offerings(academic_year,term,section,course:college_courses(code,name))), documents:college_student_application_documents(id,document_type,original_name,storage_path)')
        .eq('application_status', 'pending')
        .order('submitted_at'),
      client
        .from('college_staff_applications')
        .select('*, department:college_departments(name), documents:college_staff_application_documents(id,document_type,original_name,storage_path)')
        .eq('application_status', 'pending')
        .order('submitted_at'),
      client.from('college_departments').select('id,code,name,is_active').eq('is_active', true).order('name'),
    ])
    const error = studentResult.error ?? staffResult.error ?? departmentResult.error
    if (error) {
      setIsError(true)
      setMessage(error.message)
      setLoading(false)
      return
    }

    const sign = async (path: string) => {
      const { data, error: signedError } = await client.storage.from(bucket).createSignedUrl(path, 300)
      if (signedError) throw signedError
      return data.signedUrl
    }

    try {
      const studentRows = (studentResult.data ?? []) as StudentApplication[]
      const staffRows = (staffResult.data ?? []) as StaffApplication[]
      const signedStudents = await Promise.all(studentRows.map(async (item) => ({
        ...item,
        photoUrl: await sign(item.photo_path),
        documentUrls: Object.fromEntries(await Promise.all((item.documents ?? []).map(async (document) => [document.id, await sign(document.storage_path)]))),
      })))
      const signedStaff = await Promise.all(staffRows.map(async (item) => ({
        ...item,
        photoUrl: await sign(item.photo_path),
        documentUrls: Object.fromEntries(await Promise.all((item.documents ?? []).map(async (document) => [document.id, await sign(document.storage_path)]))),
      })))
      setStudents(signedStudents as StudentApplication[])
      setStaff(signedStaff as StaffApplication[])
      setDepartments(departmentResult.data ?? [])
      setIsError(false)
      setMessage('')
    } catch (error) {
      setIsError(true)
      setMessage(error instanceof Error ? error.message : 'Could not load private application files.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadApplications()
  }, [loadApplications])

  async function approve(kind: 'student' | 'staff', id: string) {
    if (!supabase) return
    setBusyId(id)
    setMessage('')
    const application = students.find((item) => item.id === id)
    const draft = application ? placementDrafts[id] : undefined
    const departmentId = draft?.departmentId || application?.department_id || application?.department?.id || ''
    const studyYear = Number(draft?.studyYear || application?.study_year || 0)
    const qualificationOfferingId = draft?.qualificationOfferingId
      || application?.selected_qualification_offering_id
      || relationValue(application?.qualification_choices?.[0]?.qualification)?.id
      || ''
    const hasQualificationPreferences = Boolean(application?.qualification_choices?.length)
    if (kind === 'student' && (
      !departmentId
      || !Number.isInteger(studyYear)
      || studyYear < 1
      || studyYear > 20
      || (hasQualificationPreferences && !qualificationOfferingId)
    )) {
      setBusyId('')
      setIsError(true)
      setMessage('Assign the student to one preferred course offering and a valid year of study before approving.')
      return
    }
    const result = kind === 'student'
      ? hasQualificationPreferences
        ? await supabase.rpc('approve_college_student_application_with_qualification', {
          p_application_id: id,
          p_department_id: departmentId,
          p_study_year: studyYear,
          p_qualification_offering_id: qualificationOfferingId,
        })
        : await supabase.rpc('approve_college_student_application_with_courses', {
          p_application_id: id,
          p_department_id: departmentId,
          p_study_year: studyYear,
        })
      : await supabase.rpc('approve_college_staff_application', { p_application_id: id })
    setBusyId('')
    if (result.error) {
      setIsError(true)
      setMessage(result.error.message)
      return
    }
    setIsError(false)
    setMessage(`${kind === 'student'
      ? hasQualificationPreferences
        ? 'Student admitted to the selected course offering'
        : 'Student admission and requested course enrolments'
      : 'Legacy staff registration'} approved. Assigned ID: ${result.data}`)
    await loadApplications()
  }

  async function saveApplicationPlacement(application: StudentApplication) {
    if (!supabase) return
    const draft = placementDrafts[application.id] ?? {
      departmentId: application.department_id ?? application.department?.id ?? '',
      studyYear: application.study_year?.toString() ?? '',
      qualificationOfferingId: application.selected_qualification_offering_id
        ?? relationValue(application.qualification_choices?.[0]?.qualification)?.id
        ?? '',
    }
    const studyYear = Number(draft?.studyYear)
    if (
      !draft?.departmentId
      || !Number.isInteger(studyYear)
      || studyYear < 1
      || studyYear > 20
      || (application.qualification_choices?.length && !draft.qualificationOfferingId)
    ) {
      setIsError(true)
      setMessage(application.qualification_choices?.length
        ? 'Choose a preferred course offering and valid year of study.'
        : 'Choose a department and valid year of study.')
      return
    }

    setSavingPlacementId(application.id)
    setMessage('')
    const { error } = application.qualification_choices?.length
      ? await supabase.rpc('set_college_student_application_qualification_placement', {
        p_application_id: application.id,
        p_department_id: draft.departmentId,
        p_study_year: studyYear,
        p_qualification_offering_id: draft.qualificationOfferingId,
      })
      : await supabase.rpc('set_college_student_application_department_placement', {
        p_application_id: application.id,
        p_department_id: draft.departmentId,
        p_study_year: studyYear,
      })
    setSavingPlacementId('')
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }

    const selectedDepartment = departments.find((item) => item.id === draft.departmentId)
    setStudents((current) => current.map((item) => item.id === application.id
      ? {
          ...item,
          department_id: draft.departmentId,
          department: selectedDepartment ?? item.department,
          study_year: studyYear,
          selected_qualification_offering_id: draft.qualificationOfferingId || item.selected_qualification_offering_id,
        }
      : item))
    setIsError(false)
    setMessage(`Course offering placement saved for ${application.full_name}.`)
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium text-slate-500">Registrar workspace</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">Registration review</h2>
          <p className="mt-2 text-sm text-slate-500">Review student details, place the applicant in one preferred course offering, assign a year, and approve admission.</p>
        </div>
        <button className="secondary-button w-fit" onClick={() => void loadApplications()}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="mt-5"><FormMessage error={isError} message={message} /></div>
      {loading ? <LoadingCard label="Loading applications…" /> : (
        <div className="mt-5 space-y-4">
          {!students.length && !staff.length && <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">No applications awaiting review.</div>}
          {students.map((application) => {
            const draft = placementDrafts[application.id] ?? {
              departmentId: application.department_id ?? application.department?.id ?? '',
              studyYear: application.study_year?.toString() ?? '',
              qualificationOfferingId: application.selected_qualification_offering_id
                ?? relationValue(application.qualification_choices?.[0]?.qualification)?.id
                ?? '',
            }
            const preferences = (application.qualification_choices ?? [])
              .slice()
              .sort((left, right) => left.preference_order - right.preference_order)
            const preferenceNames = preferences.map((choice) => {
              const qualification = relationValue(choice.qualification)
              return qualification ? `Preference ${choice.preference_order}: ${qualification.name}` : ''
            }).filter(Boolean)
            const choices = (application.course_choices ?? []).map((choice) => {
              const offering = relationValue(choice.offering)
              const course = relationValue(offering?.course)
              return course
                ? `${course.code} · ${course.name} · ${offering?.academic_year ?? ''} · Term ${offering?.term ?? ''} · ${offering?.section ?? ''}`
                : ''
            }).filter(Boolean)
            const hasQualificationPreferences = preferences.length > 0
            const selectedPreference = preferences.find((choice) =>
              relationValue(choice.qualification)?.id === draft.qualificationOfferingId)
            const canApprove = Boolean(
              draft.departmentId
              && Number.isInteger(Number(draft.studyYear))
              && Number(draft.studyYear) > 0
              && Number(draft.studyYear) <= 20
              && (!hasQualificationPreferences || relationValue(selectedPreference?.qualification)?.is_active),
            )
            return <ApplicationCard
              key={application.id}
              title="Student admission"
              name={application.full_name}
              subtitle={[
                application.department ? `${application.department.code} · ${application.department.name}` : 'Department not selected',
              ].join(' · ')}
              phone={application.phone}
              photoUrl={application.photoUrl}
              documents={application.documents ?? []}
              documentUrls={application.documentUrls ?? {}}
              submittedAt={application.submitted_at}
              busy={busyId === application.id}
              canApprove={canApprove}
              extra={
                <form
                  className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)_auto] lg:items-end dark:border-slate-800"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveApplicationPlacement(application)
                  }}
                >
                  <label className="block text-[11px] font-semibold">
                    Assign department
                    <select className="form-input mt-1" disabled={hasQualificationPreferences} onChange={(event) => setPlacementDrafts({
                      ...placementDrafts,
                      [application.id]: { ...draft, departmentId: event.target.value, studyYear: '' },
                    })} required value={draft.departmentId}>
                      <option value="">Choose department</option>
                      {departments.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                    </select>
                  </label>
                  <label className="block text-[11px] font-semibold">
                    Year of study
                    <input className="form-input mt-1" max="20" min="1" onChange={(event) => setPlacementDrafts({
                      ...placementDrafts,
                      [application.id]: { ...draft, studyYear: event.target.value },
                    })} required type="number" value={draft.studyYear} />
                  </label>
                  {hasQualificationPreferences && <label className="block text-[11px] font-semibold">
                    Admit to course offering
                    <select className="form-input mt-1" onChange={(event) => setPlacementDrafts({
                    ...placementDrafts,
                    [application.id]: { ...draft, qualificationOfferingId: event.target.value },
                    })} required value={draft.qualificationOfferingId}>
                    <option value="">Choose one preference</option>
                    {preferences.map((choice) => {
                      const qualification = relationValue(choice.qualification)
                      return qualification
                        ? <option key={qualification.id} value={qualification.id}>Preference {choice.preference_order} · {qualification.name}{qualification.is_active ? '' : ' (inactive)'}</option>
                        : null
                    })}
                    </select>
                  </label>}
                  <button className="secondary-button h-10 justify-center" disabled={savingPlacementId === application.id} type="submit">
                    {savingPlacementId === application.id ? 'Saving…' : 'Save placement'}
                  </button>
                  <p className="text-[11px] text-slate-500 sm:col-span-2 lg:col-span-4">{hasQualificationPreferences ? 'The applicant is admitted to exactly one selected preference; existing students and enrollments are unaffected.' : 'Legacy application: existing requested subject classes will be reviewed using the original admission workflow.'}</p>
                </form>
              }
              onApprove={() => void approve('student', application.id)}
              details={[
                ['Course-offering preferences', preferenceNames.join(' · ') || choices.join(' | ') || 'None selected'],
                ...(application.selected_qualification_offering_id
                  ? [['Registrar selection', preferences.map((choice) => relationValue(choice.qualification)).find((item) => item?.id === application.selected_qualification_offering_id)?.name ?? 'Selected course offering'] as [string, string]]
                  : []),
                ['Year of study', draft.studyYear ? `Year ${draft.studyYear}` : 'Set before approval'],
                ['Date of birth', application.date_of_birth],
                ['Gender', application.gender.replaceAll('_', ' ')],
                ['Home address', application.home_address],
                ['Emergency contact', `${application.emergency_contact_name} · ${application.emergency_contact_phone}`],
              ]}
            />
          })}
          {staff.map((application) => (
            <ApplicationCard
              key={application.id}
              title={application.staff_type === 'lecturer' ? 'Lecturer application' : 'Non-teaching staff application'}
              name={application.full_name}
              subtitle={`${application.department?.name ?? 'Department'} · ${application.job_title}`}
              phone={application.phone}
              photoUrl={application.photoUrl}
              documents={application.documents ?? []}
              documentUrls={application.documentUrls ?? {}}
              submittedAt={application.submitted_at}
              busy={busyId === application.id}
              onApprove={() => void approve('staff', application.id)}
              details={[
                ['Qualification', application.highest_qualification],
                ['Experience', `${application.years_experience} years`],
              ]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ApplicationCard({
  title,
  name,
  subtitle,
  phone,
  photoUrl,
  documents,
  documentUrls,
  submittedAt,
  busy,
  canApprove = true,
  onApprove,
  details,
  extra,
}: {
  title: string
  name: string
  subtitle: string
  phone: string
  photoUrl?: string
  documents: ApplicationDocument[]
  documentUrls: Record<string, string>
  submittedAt: string
  busy: boolean
  canApprove?: boolean
  onApprove: () => void
  details: [string, string][]
  extra?: ReactNode
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-col gap-4 sm:flex-row">
        {photoUrl
          ? <img alt={`${name} application photo`} className="h-20 w-20 rounded-xl object-cover" src={photoUrl} />
          : <span className="grid h-20 w-20 place-items-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800"><UserRound size={24} /></span>}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">{title}</p>
          <h3 className="mt-1 text-sm font-bold">{name}</h3>
          <p className="mt-1 text-xs text-slate-500">{subtitle} · {phone}</p>
          <p className="mt-1 text-[10px] text-slate-400">Submitted {new Date(submittedAt).toLocaleDateString()}</p>
        </div>
        <button className="primary-button h-10 justify-center self-start" disabled={busy || !canApprove} onClick={onApprove} type="button">
          {busy ? <LoaderCircle className="animate-spin" size={15} /> : <CheckCircle2 size={15} />}
          {busy ? 'Approving…' : canApprove ? 'Approve and enrol' : 'Complete placement first'}
        </button>
      </div>
      <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-slate-800">
        {details.map(([label, value]) => <div key={label}><dt className="text-[10px] text-slate-400">{label}</dt><dd className="mt-1 break-words text-xs font-medium">{value}</dd></div>)}
      </dl>
      {extra}
      <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
        <p className="text-[10px] font-semibold text-slate-500">Uploaded documents</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {documents.map((document) => (
            <a
              key={document.id}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium hover:border-indigo-300 dark:border-slate-700"
              href={documentUrls[document.id]}
              rel="noreferrer"
              target="_blank"
            >
              <FileText className="shrink-0 text-indigo-600 dark:text-indigo-300" size={14} />
              <span className="truncate">{document.document_type.replaceAll('_', ' ')}: {document.original_name}</span>
            </a>
          ))}
        </div>
      </div>
    </article>
  )
}

export function StudentsPage({ canManage }: { canManage: boolean }) {
  const [students, setStudents] = useState<StudentDirectoryEntry[]>([])
  const [activeDepartments, setActiveDepartments] = useState<Department[]>([])
  const [qualificationOfferings, setQualificationOfferings] = useState<QualificationOfferingChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [transferringStudent, setTransferringStudent] = useState('')
  const [transferDepartmentId, setTransferDepartmentId] = useState('')
  const [transferReason, setTransferReason] = useState('')
  const [editingStudyYearStudentId, setEditingStudyYearStudentId] = useState('')
  const [studyYearDrafts, setStudyYearDrafts] = useState<Record<string, string>>({})
  const [editingQualificationStudentId, setEditingQualificationStudentId] = useState('')
  const [qualificationDrafts, setQualificationDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const client = supabase
      if (!client) return
      const [studentResult, departmentResult, qualificationResult] = await Promise.all([
        client
          .from('college_students')
          .select('id,student_number,student_status,study_year,admitted_on,phone,photo_path,profile:college_profiles!college_students_id_fkey(full_name,email),department:college_departments(id,code,name),qualification:college_qualification_offerings!college_students_qualification_offering_id_fkey(id,name,department_id)')
          .order('student_number'),
        canManage
          ? client.from('college_departments').select('id,code,name,is_active').eq('is_active', true).order('name')
          : Promise.resolve({ data: [], error: null }),
        canManage
          ? client.from('college_qualification_offerings').select('id,department_id,name,is_active,application_open').eq('is_active', true).order('name')
          : Promise.resolve({ data: [], error: null }),
      ])
      if (!active) return
      const queryError = studentResult.error ?? departmentResult.error ?? qualificationResult.error
      if (queryError) {
        setError(queryError.message)
      } else {
        try {
          const records = (studentResult.data ?? []) as StudentDirectoryEntry[]
          const rows = await Promise.all(records.map(async (row) => {
            if (!row.photo_path) return row
            const { data: photo, error: signedError } = await client.storage.from(bucket).createSignedUrl(row.photo_path, 300)
            if (signedError) throw signedError
            return { ...row, photoUrl: photo.signedUrl }
          }))
          if (active) {
            setStudents(rows)
            setActiveDepartments(departmentResult.data ?? [])
            setQualificationOfferings(qualificationResult.data ?? [])
          }
        } catch (error) {
          if (active) setError(error instanceof Error ? error.message : 'Could not load student photos.')
        }
      }
      if (active) setLoading(false)
    }
    void load()
    return () => { active = false }
  }, [canManage])

  async function transferStudent(student: StudentDirectoryEntry) {
    if (!supabase || !canManage || !transferDepartmentId || !transferReason.trim()) return
    if (transferDepartmentId === relationValue(student.department)?.id) {
      setIsError(true)
      setMessage('This student is already assigned to that department.')
      return
    }
    setBusy(true)
    setMessage('')
    const { error: transferError } = await supabase.rpc('transfer_college_student_department', {
      p_student_id: student.id,
      p_department_id: transferDepartmentId,
      p_reason: transferReason.trim(),
    })
    setBusy(false)
    if (transferError) {
      setIsError(true)
      setMessage(transferError.message)
      return
    }
    const nextDepartment = activeDepartments.find((department) => department.id === transferDepartmentId)
    setStudents((current) => current.map((item) => item.id === student.id
      ? { ...item, department: nextDepartment ?? null, qualification: null }
      : item))
    setQualificationDrafts((current) => ({ ...current, [student.id]: '' }))
    setIsError(false)
    setMessage(`Department updated for ${student.student_number}. Existing course enrollments were retained.`)
    setTransferringStudent('')
    setTransferDepartmentId('')
    setTransferReason('')
  }

  async function saveStudentStudyYear(student: StudentDirectoryEntry) {
    if (!supabase || !canManage) return
    const studyYear = Number(studyYearDrafts[student.id])
    if (!Number.isInteger(studyYear) || studyYear < 1 || studyYear > 20) {
      setIsError(true)
      setMessage('Enter a valid year of study.')
      return
    }

    setBusy(true)
    setMessage('')
    const { error: updateError } = await supabase.rpc('set_college_student_study_year', {
      p_student_id: student.id,
      p_study_year: studyYear,
    })
    setBusy(false)
    if (updateError) {
      setIsError(true)
      setMessage(updateError.message)
      return
    }

    setStudents((current) => current.map((item) =>
      item.id === student.id ? { ...item, study_year: studyYear } : item,
    ))
    setEditingStudyYearStudentId('')
    setIsError(false)
    setMessage(`Year ${studyYear} saved for ${student.student_number}.`)
  }

  async function assignStudentQualification(student: StudentDirectoryEntry) {
    if (!supabase || !canManage) return
    const qualificationId = qualificationDrafts[student.id]
      ?? relationValue(student.qualification)?.id
      ?? ''
    const qualification = qualificationOfferings.find((item) =>
      item.id === qualificationId
      && item.department_id === relationValue(student.department)?.id)
    if (!qualification) {
      setIsError(true)
      setMessage('Choose an active course offering from the student’s department.')
      return
    }

    setBusy(true)
    setMessage('')
    const { error: assignmentError } = await supabase.rpc('set_college_student_qualification', {
      p_student_id: student.id,
      p_qualification_offering_id: qualification.id,
    })
    setBusy(false)
    if (assignmentError) {
      setIsError(true)
      setMessage(assignmentError.message)
      return
    }

    setStudents((current) => current.map((item) => item.id === student.id
      ? { ...item, qualification: { id: qualification.id, name: qualification.name, department_id: qualification.department_id } }
      : item))
    setEditingQualificationStudentId('')
    setIsError(false)
    setMessage(`Course offering ${qualification.name} assigned to ${student.student_number}.`)
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h2 className="text-2xl font-bold tracking-tight">Students</h2>
      <p className="mt-2 text-sm text-slate-500">Approved student records and admission numbers.</p>
      {error && <div className="mt-5"><FormMessage error message={error} /></div>}
      {message && <div className="mt-5"><FormMessage error={isError} message={message} /></div>}
      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? <LoadingCard label="Loading student records…" /> : students.length ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {students.map((student) => {
              const profile = relationValue(student.profile)
              const department = relationValue(student.department)
              return (
                <div key={student.id} className="p-4">
                <div className="flex items-center gap-3">
                  {student.photoUrl ? <img alt="" className="h-10 w-10 rounded-full object-cover" src={student.photoUrl} /> : <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800"><UserRound size={17} /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{profile?.full_name ?? 'Student'}</p>
                  <p className="mt-1 truncate text-[10px] text-slate-500">{student.student_number} · {department?.code ?? 'Department not assigned'} · {department?.name ?? ''} · {profile?.email ?? ''}</p>
                  <p className="mt-1 truncate text-[10px] text-slate-500">Course offering: {relationValue(student.qualification)?.name ?? 'Not assigned'}</p>
                </div>
                <span className="hidden text-[10px] text-slate-500 sm:block">{student.study_year ? `Year ${student.study_year}` : 'Year not set'} · {student.student_status}</span>
                {canManage && <button className="secondary-button justify-center" disabled={busy} onClick={() => {
                  setEditingStudyYearStudentId(editingStudyYearStudentId === student.id ? '' : student.id)
                  setStudyYearDrafts({ ...studyYearDrafts, [student.id]: student.study_year?.toString() ?? '' })
                }} type="button">Set year</button>}
                {canManage && <button className="secondary-button justify-center" disabled={busy || !department} onClick={() => {
                  setEditingQualificationStudentId(editingQualificationStudentId === student.id ? '' : student.id)
                  setQualificationDrafts((current) => ({
                    ...current,
                    [student.id]: relationValue(student.qualification)?.id ?? '',
                  }))
                }} type="button">{relationValue(student.qualification) ? 'Change offering' : 'Assign offering'}</button>}
                {canManage && <button className="secondary-button justify-center" disabled={busy} onClick={() => {
                  setTransferringStudent(transferringStudent === student.id ? '' : student.id)
                  setTransferDepartmentId('')
                  setTransferReason('')
                }} type="button">Change department</button>}
                </div>
                {canManage && editingStudyYearStudentId === student.id && (
                  <form className="mt-4 flex flex-wrap items-end gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60" onSubmit={(event) => {
                    event.preventDefault()
                    void saveStudentStudyYear(student)
                  }}>
                    <label className="block text-[11px] font-semibold">
                      Year of study
                      <input
                        className="form-input mt-1 w-32"
                        max="20"
                        min="1"
                        onChange={(event) => setStudyYearDrafts({ ...studyYearDrafts, [student.id]: event.target.value })}
                        required
                        type="number"
                        value={studyYearDrafts[student.id] ?? ''}
                      />
                    </label>
                    <button className="primary-button h-10 justify-center" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save year'}</button>
                  </form>
                )}
                {canManage && editingQualificationStudentId === student.id && (
                  <form className="mt-4 flex flex-wrap items-end gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60" onSubmit={(event) => {
                    event.preventDefault()
                    void assignStudentQualification(student)
                  }}>
                    <label className="block min-w-64 flex-1 text-[11px] font-semibold">
                      Course offering
                      <select className="form-input mt-1" disabled={!department} onChange={(event) => setQualificationDrafts((current) => ({
                        ...current,
                        [student.id]: event.target.value,
                      }))} required value={qualificationDrafts[student.id] ?? ''}>
                        <option value="">Choose an active course offering</option>
                        {qualificationOfferings.filter((item) => item.department_id === department?.id).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                    </label>
                    <button className="primary-button h-10 justify-center" disabled={busy || !department} type="submit">{busy ? 'Saving…' : 'Save course offering'}</button>
                    <p className="w-full text-[11px] text-slate-500">Assignment preserves existing enrollments. Run timetable generation for the appropriate academic year and term to enroll the student in matching scheduled classes.</p>
                  </form>
                )}
                {canManage && transferringStudent === student.id && (
                  <form className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] dark:bg-slate-800/60" onSubmit={(event) => {
                    event.preventDefault()
                    void transferStudent(student)
                  }}>
                    <label className="block text-[11px] font-semibold">
                      New department
                      <select className="form-input mt-1" required value={transferDepartmentId} onChange={(event) => {
                        setTransferDepartmentId(event.target.value)
                      }}>
                        <option value="">Choose an active department</option>
                        {activeDepartments.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                      </select>
                    </label>
                    <label className="block text-[11px] font-semibold">
                      Reason for department change
                      <input className="form-input mt-1" maxLength={500} required value={transferReason} onChange={(event) => setTransferReason(event.target.value)} />
                    </label>
                    <button className="primary-button h-10 justify-center self-end" disabled={busy} type="submit">{busy ? 'Saving…' : 'Assign department'}</button>
                    <p className="text-[11px] text-slate-500 sm:col-span-3">Existing enrollments are retained. After assigning a course offering, run timetable generation for the appropriate academic year and term to enroll matching scheduled classes.</p>
                  </form>
                )}
                </div>
              )
            })}
          </div>
        ) : <p className="p-8 text-center text-sm text-slate-500">No approved students yet. Use Registration review to process applications.</p>}
      </section>
    </div>
  )
}

export function StaffPage({ role }: { role: CollegeRole }) {
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ email: '', fullName: '', phone: '', staffType: 'lecturer', departmentId: '', jobTitle: '' })

  const loadStaff = useCallback(async (isActive: () => boolean = () => true) => {
    const client = supabase
    if (!client) {
      if (isActive()) {
        setError('Supabase is not configured.')
        setLoading(false)
      }
      return
    }
    setLoading(true)
    const ownDepartmentId = role === 'department_head'
      ? (await client.from('college_staff').select('department_id').eq('id', (await client.auth.getUser()).data.user?.id ?? '').maybeSingle()).data?.department_id ?? null
      : null
    const [staffResult, departmentResult] = await Promise.all([
      client
        .from('college_staff')
        .select('id,staff_number,department_id,job_title,employment_status,phone,photo_path,profile:college_profiles!college_staff_id_fkey(full_name,email,role),department:college_departments(name)')
        .order('staff_number'),
      client.from('college_departments').select('id,code,name,is_active').eq('is_active', true).order('name'),
    ])
    const queryError = staffResult.error ?? departmentResult.error
    if (queryError) {
      if (isActive()) {
        setError(queryError.message)
        setLoading(false)
      }
      return
    }
    try {
      const records = ((staffResult.data ?? []) as StaffDirectoryEntry[])
        .filter((row) => !ownDepartmentId || row.department_id === ownDepartmentId)
      const rows = await Promise.all(records.map(async (row) => {
        if (!row.photo_path) return row
        const { data: photo, error: signedError } = await client.storage.from(bucket).createSignedUrl(row.photo_path, 300)
        if (signedError) throw signedError
        return { ...row, photoUrl: photo.signedUrl }
      }))
      if (isActive()) {
        setStaff(rows)
        const visibleDepartments = ownDepartmentId
          ? (departmentResult.data ?? []).filter((department) => department.id === ownDepartmentId)
          : (departmentResult.data ?? [])
        setDepartments(visibleDepartments)
        if (ownDepartmentId) setForm((current) => ({ ...current, departmentId: ownDepartmentId }))
        setError('')
      }
    } catch (caught) {
      if (isActive()) setError(caught instanceof Error ? caught.message : 'Could not load staff photos.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void loadStaff(() => active)
    return () => { active = false }
  }, [loadStaff])

  async function createStaffAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) {
      setError('Supabase is not configured.')
      return
    }
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      const { data, error: inviteError } = await supabase.functions.invoke<{ staff_number: string }>('create-staff-account', {
        body: {
          email: form.email.trim(),
          full_name: form.fullName.trim(),
          phone: form.phone.trim(),
          staff_type: form.staffType,
          department_id: form.departmentId,
          job_title: form.jobTitle.trim(),
        },
      })
      if (inviteError) {
        let errorMessage = inviteError.message
        if (inviteError.name === 'FunctionsFetchError') {
          errorMessage = `Could not reach the staff invitation Edge Function. Deploy it with "supabase functions deploy create-staff-account". Set APP_URL to the deployed portal base URL (include any deployment path); its origin must match ${window.location.origin}. Ensure the function's Supabase secrets are configured and APP_URL is included in Supabase Auth's allowed redirect URLs.`
        } else if ('context' in inviteError && inviteError.context instanceof Response) {
          const result: unknown = await inviteError.context.clone().json().catch(() => null)
          if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
            errorMessage = result.error
          }
        }
        setError(errorMessage)
        return
      }
      setSuccess(`Invitation sent. Staff number: ${data?.staff_number ?? 'assigned'}. The staff member will set their own password from the email link.`)
      setForm({ email: '', fullName: '', phone: '', staffType: 'lecturer', departmentId: '', jobTitle: '' })
      await loadStaff()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The staff invitation could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h2 className="text-2xl font-bold tracking-tight">Staff</h2>
      <p className="mt-2 text-sm text-slate-500">Administrator-managed lecturer and non-teaching staff accounts.</p>
      {error && <div className="mt-5"><FormMessage error message={error} /></div>}
      {success && <div className="mt-5"><FormMessage message={success} /></div>}
      <form className="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2 lg:grid-cols-3" onSubmit={createStaffAccount}>
        <h3 className="text-sm font-bold sm:col-span-2 lg:col-span-3">Create staff account and send secure invite</h3>
        <Field label="Full name" required><input className="form-input" maxLength={120} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required value={form.fullName} /></Field>
        <Field label="Email address" required><input className="form-input" onChange={(event) => setForm({ ...form, email: event.target.value })} required type="email" value={form.email} /></Field>
        <Field label="Phone number" required><input className="form-input" maxLength={30} onChange={(event) => setForm({ ...form, phone: event.target.value })} required type="tel" value={form.phone} /></Field>
        <Field label="Staff type" required><select className="form-input" onChange={(event) => setForm({ ...form, staffType: event.target.value })} value={form.staffType}><option value="lecturer">Lecturer</option>{role !== 'department_head' && <option value="non_teaching_staff">Non-teaching staff</option>}</select></Field>
        <Field label="Department" required><select className="form-input" onChange={(event) => setForm({ ...form, departmentId: event.target.value })} required value={form.departmentId}><option value="">Choose department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.code} · {department.name}</option>)}</select></Field>
        <Field label="Job title" required><input className="form-input" maxLength={120} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} required value={form.jobTitle} /></Field>
        <button className="primary-button sm:col-span-2 lg:col-span-3" disabled={busy || !departments.length} type="submit">{busy ? 'Sending secure invite…' : 'Create staff account'}</button>
        <p className="text-[11px] leading-5 text-slate-500 sm:col-span-2 lg:col-span-3">No password is created or shown here. Supabase sends a one-time email invitation so the staff member can set their own password.</p>
      </form>
      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? <LoadingCard label="Loading staff records…" /> : staff.length ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {staff.map((member) => {
              const profile = relationValue(member.profile)
              const department = relationValue(member.department)
              return (
                <div key={member.id} className="flex items-center gap-3 p-4">
                  {member.photoUrl ? <img alt="" className="h-10 w-10 rounded-full object-cover" src={member.photoUrl} /> : <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800"><UserRound size={17} /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{profile?.full_name ?? 'Staff member'}</p>
                  <p className="mt-1 truncate text-[10px] text-slate-500">{member.staff_number} · {member.job_title} · {department?.name ?? 'Department'}</p>
                </div>
                <span className="hidden text-[10px] capitalize text-slate-500 sm:block">{profile?.role.replaceAll('_', ' ')}</span>
                </div>
              )
            })}
          </div>
        ) : <p className="p-8 text-center text-sm text-slate-500">No staff accounts have been created yet. Use the invite form above to add staff.</p>}
      </section>
    </div>
  )
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900">
      <LoaderCircle className="animate-spin" size={16} />
      {label}
    </div>
  )
}
