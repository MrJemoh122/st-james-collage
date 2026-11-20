import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { CheckCircle2, FileText, ImagePlus, LoaderCircle, Plus, RefreshCw, ShieldCheck, UserRound } from 'lucide-react'
import { supabase } from '../lib/supabase'

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
type Programme = { id: string; code: string; name: string }
type ApplicationFile = { file: File; type: string }
type Related<T> = T | T[] | null
type StudentDirectoryEntry = {
  id: string
  student_number: string
  student_status: string
  phone: string | null
  photo_path: string | null
  photoUrl?: string
  profile: Related<{ full_name: string | null; email: string | null }>
  programme: Related<{ id: string; name: string; code: string }>
}
type StaffDirectoryEntry = {
  id: string
  staff_number: string
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
  const [kind, setKind] = useState<'student' | 'staff'>('student')
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
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-600 text-white">
              <UserRound size={21} />
            </span>
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
                    {existing.status === 'approved'
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
            <>
              <div className="mt-6 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                <button
                  aria-pressed={kind === 'student'}
                  className={`rounded-lg px-3 py-2.5 text-xs font-semibold ${kind === 'student' ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-500'}`}
                  onClick={() => setKind('student')}
                  type="button"
                >
                  Student admission
                </button>
                <button
                  aria-pressed={kind === 'staff'}
                  className={`rounded-lg px-3 py-2.5 text-xs font-semibold ${kind === 'staff' ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-500'}`}
                  onClick={() => setKind('staff')}
                  type="button"
                >
                  Lecturer / staff
                </button>
              </div>
              <div className="mt-6">
                {kind === 'student'
                  ? <StudentApplicationForm user={user} onSubmitted={loadApplication} />
                  : <StaffApplicationForm user={user} onSubmitted={loadApplication} />}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

function StudentApplicationForm({ user, onSubmitted }: Props & { onSubmitted: () => Promise<void> }) {
  const [programmes, setProgrammes] = useState<Programme[]>([])
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
    programmeId: '',
  })

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('college_programmes')
      .select('id,code,name')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error }) => {
        if (error) setLoadError(error.message)
        else setProgrammes(data ?? [])
      })
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    if (!supabase) return showError('Supabase is not configured.')
    if (!photo || !identity || !certificate) return showError('Add a photo, identity document, and academic certificate.')
    if (otherDocuments.length > 6) return showError('You can upload up to six additional documents.')
    if (!isAllowedPhoto(photo)) return showError('Photo must be a JPEG, PNG, or WebP image no larger than 10 MB.')
    let photoSignatureMatches: boolean
    try {
      photoSignatureMatches = await matchesFileSignature(photo)
    } catch {
      return showError('Could not read the selected photo. Please choose it again.')
    }
    if (!photoSignatureMatches) return showError('The selected photo does not match its file type.')
    const documents: ApplicationFile[] = [
      { file: identity, type: 'identity' },
      { file: certificate, type: 'certificate' },
      ...otherDocuments.map((file) => ({ file, type: 'other' })),
    ]
    if (documents.some(({ file }) => !isAllowedDocument(file))) {
      return showError('Documents must be PDF, JPEG, PNG, or WebP and no larger than 10 MB each.')
    }
    if (documents.length > 8) return showError('Upload no more than eight documents.')
    let documentSignaturesMatch: boolean
    try {
      documentSignaturesMatch = (await Promise.all(documents.map(({ file }) => matchesFileSignature(file)))).every(Boolean)
    } catch {
      return showError('Could not read the selected documents. Please choose them again.')
    }
    if (!documentSignaturesMatch) {
      return showError('One or more documents do not match their file type.')
    }

    setBusy(true)
    const uploaded: string[] = []
    try {
      const photoPath = await uploadFile(user.id, 'student', 'photo', photo)
      uploaded.push(photoPath)
      const uploadedDocuments: UploadedDocument[] = []
      for (const document of documents) {
        const path = await uploadFile(user.id, 'student', 'documents', document.file)
        uploaded.push(path)
        uploadedDocuments.push({ path, name: document.file.name, type: document.type })
      }

      const { error } = await supabase.rpc('submit_college_student_application', {
        p_full_name: form.fullName,
        p_phone: form.phone,
        p_date_of_birth: form.dateOfBirth,
        p_gender: form.gender,
        p_home_address: form.address,
        p_emergency_contact_name: form.emergencyName,
        p_emergency_contact_phone: form.emergencyPhone,
        p_programme_id: form.programmeId,
        p_photo_path: photoPath,
        p_documents: uploadedDocuments,
      })
      if (error) throw error
      setMessage('Application submitted. Your account will remain pending until the registrar reviews it.')
      await onSubmitted()
    } catch (error) {
      let cleanupMessage = ''
      if (uploaded.length) {
        const cleanup = await supabase.storage.from(bucket).remove(uploaded)
        if (cleanup.error) cleanupMessage = ` Uploaded files need cleanup: ${cleanup.error.message}`
      }
      showError(`${error instanceof Error ? error.message : 'Student application could not be submitted.'}${cleanupMessage}`)
    } finally {
      setBusy(false)
    }
  }

  function showError(text: string) {
    setIsError(true)
    setMessage(text)
  }

  if (loadError) return <FormMessage error message={`Could not load active programmes: ${loadError}`} />

  return (
    <form className="space-y-5" onSubmit={submit}>
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
        <Field label="Programme" required>
          <select className="form-input" required value={form.programmeId} onChange={(e) => setForm({ ...form, programmeId: e.target.value })}>
            <option value="">Choose an active programme</option>
            {programmes.map((programme) => <option key={programme.id} value={programme.id}>{programme.code} — {programme.name}</option>)}
          </select>
        </Field>
        <Field label="Emergency contact name" required>
          <input className="form-input" maxLength={120} required value={form.emergencyName} onChange={(e) => setForm({ ...form, emergencyName: e.target.value })} />
        </Field>
        <Field label="Emergency contact phone" required>
          <input className="form-input" maxLength={30} required type="tel" value={form.emergencyPhone} onChange={(e) => setForm({ ...form, emergencyPhone: e.target.value })} />
        </Field>
      </div>
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
      <button className="primary-button h-11 w-full justify-center sm:w-auto" disabled={busy || programmes.length === 0} type="submit">
        {busy ? <><LoaderCircle className="animate-spin" size={16} /> Uploading application…</> : 'Submit student application'}
      </button>
      {programmes.length === 0 && <p className="text-xs text-slate-500">Applications open when the registrar adds active programmes.</p>}
    </form>
  )
}

function StaffApplicationForm({ user, onSubmitted }: Props & { onSubmitted: () => Promise<void> }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [cv, setCv] = useState<File | null>(null)
  const [qualifications, setQualifications] = useState<File[]>([])
  const [form, setForm] = useState({
    staffType: 'lecturer',
    fullName: '',
    phone: '',
    departmentId: '',
    jobTitle: '',
    qualification: '',
    experience: '0',
  })

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('college_departments')
      .select('id,code,name,is_active')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error }) => {
        if (error) setLoadError(error.message)
        else setDepartments(data ?? [])
      })
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    if (!supabase) return showError('Supabase is not configured.')
    if (!photo || !cv) return showError('Add a photo and CV before submitting.')
    if (qualifications.length > 7) return showError('You can upload up to seven supporting documents.')
    if (!isAllowedPhoto(photo)) return showError('Photo must be a JPEG, PNG, or WebP image no larger than 10 MB.')
    let photoSignatureMatches: boolean
    try {
      photoSignatureMatches = await matchesFileSignature(photo)
    } catch {
      return showError('Could not read the selected photo. Please choose it again.')
    }
    if (!photoSignatureMatches) return showError('The selected photo does not match its file type.')
    const documents: ApplicationFile[] = [
      { file: cv, type: 'cv' },
      ...qualifications.map((file) => ({ file, type: 'qualification' })),
    ]
    if (documents.some(({ file }) => !isAllowedDocument(file))) {
      return showError('Documents must be PDF, JPEG, PNG, or WebP and no larger than 10 MB each.')
    }
    let documentSignaturesMatch: boolean
    try {
      documentSignaturesMatch = (await Promise.all(documents.map(({ file }) => matchesFileSignature(file)))).every(Boolean)
    } catch {
      return showError('Could not read the selected documents. Please choose them again.')
    }
    if (!documentSignaturesMatch) {
      return showError('One or more documents do not match their file type.')
    }

    setBusy(true)
    const uploaded: string[] = []
    try {
      const photoPath = await uploadFile(user.id, 'staff', 'photo', photo)
      uploaded.push(photoPath)
      const uploadedDocuments: UploadedDocument[] = []
      for (const document of documents) {
        const path = await uploadFile(user.id, 'staff', 'documents', document.file)
        uploaded.push(path)
        uploadedDocuments.push({ path, name: document.file.name, type: document.type })
      }
      const { error } = await supabase.rpc('submit_college_staff_application', {
        p_staff_type: form.staffType,
        p_full_name: form.fullName,
        p_phone: form.phone,
        p_department_id: form.departmentId,
        p_job_title: form.jobTitle,
        p_highest_qualification: form.qualification,
        p_years_experience: Number(form.experience),
        p_photo_path: photoPath,
        p_documents: uploadedDocuments,
      })
      if (error) throw error
      setMessage('Staff application submitted. Your account will remain pending until the college reviews it.')
      await onSubmitted()
    } catch (error) {
      let cleanupMessage = ''
      if (uploaded.length) {
        const cleanup = await supabase.storage.from(bucket).remove(uploaded)
        if (cleanup.error) cleanupMessage = ` Uploaded files need cleanup: ${cleanup.error.message}`
      }
      showError(`${error instanceof Error ? error.message : 'Staff application could not be submitted.'}${cleanupMessage}`)
    } finally {
      setBusy(false)
    }
  }

  function showError(text: string) {
    setIsError(true)
    setMessage(text)
  }

  if (loadError) return <FormMessage error message={`Could not load active departments: ${loadError}`} />

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Application type" required>
          <select className="form-input" value={form.staffType} onChange={(e) => setForm({ ...form, staffType: e.target.value })}>
            <option value="lecturer">Lecturer / instructor</option>
            <option value="non_teaching_staff">Non-teaching staff</option>
          </select>
        </Field>
        <Field label="Full legal name" required>
          <input className="form-input" autoComplete="name" maxLength={120} required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </Field>
        <Field label="Phone number" required>
          <input className="form-input" autoComplete="tel" maxLength={30} required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Department" required>
          <select className="form-input" required value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
            <option value="">Choose an active department</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.code} — {department.name}</option>)}
          </select>
        </Field>
        <Field label="Job title" required>
          <input className="form-input" maxLength={120} required value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
        </Field>
        <Field label="Highest qualification" required>
          <input className="form-input" maxLength={160} required value={form.qualification} onChange={(e) => setForm({ ...form, qualification: e.target.value })} />
        </Field>
        <Field label="Years of experience" required>
          <input className="form-input" max="60" min="0" required type="number" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FileField label="Profile photo" accept="image/jpeg,image/png,image/webp" file={photo} onChange={setPhoto} required hint="JPEG, PNG, WebP · up to 10 MB" />
        <FileField label="CV / résumé" accept=".pdf,image/jpeg,image/png,image/webp" file={cv} onChange={setCv} required hint="PDF or image · up to 10 MB" />
        <label className="block sm:col-span-2">
          <span className="mb-2 block text-xs font-semibold">Qualification documents <span className="font-normal text-slate-500">(optional, up to 7)</span></span>
          <span className="flex min-h-12 items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
            <FileText className="shrink-0 text-slate-400" size={17} />
            <span className="min-w-0 flex-1 truncate text-xs">{qualifications.length ? `${qualifications.length} file(s) selected` : 'Choose files'}</span>
            <input accept=".pdf,image/jpeg,image/png,image/webp" className="sr-only" multiple onChange={(e) => setQualifications(Array.from(e.target.files ?? []))} type="file" />
          </span>
        </label>
      </div>
      <FormMessage error={isError} message={message} />
      <button className="primary-button h-11 w-full justify-center sm:w-auto" disabled={busy || departments.length === 0} type="submit">
        {busy ? <><LoaderCircle className="animate-spin" size={16} /> Uploading application…</> : 'Submit staff application'}
      </button>
      {departments.length === 0 && <p className="text-xs text-slate-500">Applications open when the college adds active departments.</p>}
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

export function DepartmentsPage({ canManage }: { canManage: boolean }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  const loadDepartments = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const { data, error } = await supabase
      .from('college_departments')
      .select('id,code,name,is_active')
      .order('name')
    if (error) {
      setIsError(true)
      setMessage(error.message)
    } else {
      setDepartments(data ?? [])
      setMessage('')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadDepartments()
  }, [loadDepartments])

  async function addDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage('')
    const { error } = await supabase.from('college_departments').insert({
      code: code.trim().toUpperCase(),
      name: name.trim(),
    })
    setBusy(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setIsError(false)
    setMessage('Department created.')
    setCode('')
    setName('')
    await loadDepartments()
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

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <p className="text-xs font-medium text-slate-500">Academic structure</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Departments</h2>
        <p className="mt-2 text-sm text-slate-500">Manage college departments without deleting records that may be linked to students or staff.</p>
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
      <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? <LoadingCard label="Loading departments…" /> : departments.length ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {departments.map((department) => (
              <div key={department.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex-1">
                  <p className="text-sm font-semibold">{department.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{department.code}</p>
                </div>
                <span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold ${department.is_active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                  {department.is_active ? 'Active' : 'Inactive'}
                </span>
                {canManage && (
                  <button className="secondary-button justify-center" onClick={() => void toggleActive(department)} type="button">
                    {department.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : <p className="p-8 text-center text-sm text-slate-500">No departments yet.</p>}
      </section>
    </div>
  )
}

type ProgrammeRecord = Programme & {
  department_id: string
  award: string | null
  qualification_level: string
  duration_years: number | null
  is_active: boolean
  department?: { name: string } | { name: string }[] | null
}

export function ProgrammesPage({ canManage }: { canManage: boolean }) {
  const [programmes, setProgrammes] = useState<ProgrammeRecord[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [award, setAward] = useState('')
  const [qualificationLevel, setQualificationLevel] = useState('Certificate')
  const [customQualification, setCustomQualification] = useState('')
  const [duration, setDuration] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  const loadProgrammes = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const [programmeResult, departmentResult] = await Promise.all([
      supabase
        .from('college_programmes')
        .select('id,code,name,department_id,award,qualification_level,duration_years,is_active,department:college_departments(name)')
        .order('name'),
      supabase
        .from('college_departments')
        .select('id,code,name,is_active')
        .eq('is_active', true)
        .order('name'),
    ])
    const error = programmeResult.error ?? departmentResult.error
    if (error) {
      setIsError(true)
      setMessage(error.message)
    } else {
      setProgrammes((programmeResult.data ?? []) as ProgrammeRecord[])
      setDepartments(departmentResult.data ?? [])
      setMessage('')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadProgrammes()
  }, [loadProgrammes])

  async function addProgramme(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage('')
    const officialCode = code.trim().toUpperCase()
    const selectedQualification = qualificationLevel === 'Other'
      ? customQualification.trim()
      : qualificationLevel
    if (!/^[A-Z0-9]{2,12}$/.test(officialCode)) {
      setBusy(false)
      setIsError(true)
      setMessage('Use a unique official course code with 2 to 12 letters or numbers.')
      return
    }
    if (!selectedQualification) {
      setBusy(false)
      setIsError(true)
      setMessage('Enter the approved qualification level.')
      return
    }
    const { error } = await supabase.from('college_programmes').insert({
      code: officialCode,
      name: name.trim(),
      department_id: departmentId,
      award: award.trim() || null,
      qualification_level: selectedQualification,
      duration_years: Number(duration),
    })
    setBusy(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setIsError(false)
    setMessage('Programme created.')
    setCode('')
    setName('')
    setAward('')
    setQualificationLevel('Certificate')
    setCustomQualification('')
    setDuration('')
    await loadProgrammes()
  }

  async function toggleActive(programme: ProgrammeRecord) {
    if (!supabase || !canManage) return
    const { error } = await supabase
      .from('college_programmes')
      .update({ is_active: !programme.is_active })
      .eq('id', programme.id)
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setIsError(false)
    setMessage(`Programme ${programme.is_active ? 'deactivated' : 'activated'}.`)
    await loadProgrammes()
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <p className="text-xs font-medium text-slate-500">Academic structure</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Programmes</h2>
        <p className="mt-2 text-sm text-slate-500">Configure the official course code and qualification level used for student registration numbers.</p>
      </div>
      {canManage && (
        <form className="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900" onSubmit={addProgramme}>
          <Field label="Official course code" required>
            <input className="form-input uppercase" maxLength={12} pattern="[A-Za-z0-9]{2,12}" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Programme name" required>
            <input className="form-input" maxLength={160} required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Department" required>
            <select className="form-input" required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Choose an active department</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.code} — {department.name}</option>)}
            </select>
          </Field>
          <Field label="Qualification level" required>
            <select className="form-input" required value={qualificationLevel} onChange={(e) => setQualificationLevel(e.target.value)}>
              <option value="Certificate">Certificate</option>
              <option value="Diploma">Diploma</option>
              <option value="Other">Other approved level</option>
            </select>
          </Field>
          {qualificationLevel === 'Other' && (
            <Field label="Approved qualification level" required>
              <input className="form-input" maxLength={80} required value={customQualification} onChange={(e) => setCustomQualification(e.target.value)} />
            </Field>
          )}
          <Field label="Award (optional)">
            <input className="form-input" maxLength={120} value={award} onChange={(e) => setAward(e.target.value)} />
          </Field>
          <Field label="Duration in years" required>
            <input className="form-input" max="20" min="1" required type="number" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
          <button className="primary-button h-11 justify-center self-end" disabled={busy || departments.length === 0} type="submit">
            <Plus size={16} /> {busy ? 'Saving…' : 'Add programme'}
          </button>
        </form>
      )}
      <div className="mt-5"><FormMessage error={isError} message={message} /></div>
      <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? <LoadingCard label="Loading programmes…" /> : programmes.length ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {programmes.map((programme) => (
              <div key={programme.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex-1">
                  <p className="text-sm font-semibold">{programme.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{programme.code} · {programme.qualification_level} · {Array.isArray(programme.department) ? programme.department[0]?.name ?? 'Department' : programme.department?.name ?? 'Department'}{programme.award ? ` · ${programme.award}` : ''}</p>
                </div>
                {programme.duration_years && <span className="text-[10px] text-slate-500">{programme.duration_years} years</span>}
                <span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold ${programme.is_active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                  {programme.is_active ? 'Active' : 'Inactive'}
                </span>
                {canManage && (
                  <button className="secondary-button justify-center" onClick={() => void toggleActive(programme)} type="button">
                    {programme.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : <p className="p-8 text-center text-sm text-slate-500">No programmes yet. Add one after creating a department.</p>}
      </section>
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
  full_name: string
  phone: string
  date_of_birth: string
  gender: string
  home_address: string
  emergency_contact_name: string
  emergency_contact_phone: string
  photo_path: string
  submitted_at: string
  programme?: { code: string; name: string } | null
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
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  const loadApplications = useCallback(async () => {
    const client = supabase
    if (!client) return
    setLoading(true)
    const [studentResult, staffResult] = await Promise.all([
      client
        .from('college_student_applications')
        .select('*, programme:college_programmes(code,name), documents:college_student_application_documents(id,document_type,original_name,storage_path)')
        .eq('application_status', 'pending')
        .order('submitted_at'),
      client
        .from('college_staff_applications')
        .select('*, department:college_departments(name), documents:college_staff_application_documents(id,document_type,original_name,storage_path)')
        .eq('application_status', 'pending')
        .order('submitted_at'),
    ])
    const error = studentResult.error ?? staffResult.error
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
    const rpc = kind === 'student'
      ? 'approve_college_student_application'
      : 'approve_college_staff_application'
    const { data, error } = await supabase.rpc(rpc, { p_application_id: id })
    setBusyId('')
    if (error) {
      setIsError(true)
      setMessage(error.message)
      return
    }
    setIsError(false)
    setMessage(`${kind === 'student' ? 'Student admission' : 'Staff registration'} approved. Assigned ID: ${data}`)
    await loadApplications()
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium text-slate-500">Registrar workspace</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">Registration review</h2>
          <p className="mt-2 text-sm text-slate-500">Review private applicant details and documents before assigning a college role.</p>
        </div>
        <button className="secondary-button w-fit" onClick={() => void loadApplications()}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="mt-5"><FormMessage error={isError} message={message} /></div>
      {loading ? <LoadingCard label="Loading applications…" /> : (
        <div className="mt-5 space-y-4">
          {!students.length && !staff.length && <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">No applications awaiting review.</div>}
          {students.map((application) => (
            <ApplicationCard
              key={application.id}
              title="Student admission"
              name={application.full_name}
              subtitle={`${application.programme?.code ?? ''} ${application.programme?.name ?? ''}`}
              phone={application.phone}
              photoUrl={application.photoUrl}
              documents={application.documents ?? []}
              documentUrls={application.documentUrls ?? {}}
              submittedAt={application.submitted_at}
              busy={busyId === application.id}
              onApprove={() => void approve('student', application.id)}
              details={[
                ['Date of birth', application.date_of_birth],
                ['Gender', application.gender.replaceAll('_', ' ')],
                ['Home address', application.home_address],
                ['Emergency contact', `${application.emergency_contact_name} · ${application.emergency_contact_phone}`],
              ]}
            />
          ))}
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
  onApprove,
  details,
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
  onApprove: () => void
  details: [string, string][]
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
        <button className="primary-button h-10 justify-center self-start" disabled={busy} onClick={onApprove} type="button">
          {busy ? <LoaderCircle className="animate-spin" size={15} /> : <CheckCircle2 size={15} />}
          {busy ? 'Approving…' : 'Approve'}
        </button>
      </div>
      <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-slate-800">
        {details.map(([label, value]) => <div key={label}><dt className="text-[10px] text-slate-400">{label}</dt><dd className="mt-1 break-words text-xs font-medium">{value}</dd></div>)}
      </dl>
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
  const [activeProgrammes, setActiveProgrammes] = useState<Programme[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [transferringStudent, setTransferringStudent] = useState('')
  const [transferProgrammeId, setTransferProgrammeId] = useState('')
  const [transferReason, setTransferReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const client = supabase
      if (!client) return
      const [studentResult, programmeResult] = await Promise.all([
        client
          .from('college_students')
          .select('id,student_number,student_status,admitted_on,phone,photo_path,profile:college_profiles!college_students_id_fkey(full_name,email),programme:college_programmes(id,name,code)')
          .order('student_number'),
        canManage
          ? client.from('college_programmes').select('id,code,name').eq('is_active', true).order('name')
          : Promise.resolve({ data: [], error: null }),
      ])
      if (!active) return
      const queryError = studentResult.error ?? programmeResult.error
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
            setActiveProgrammes(programmeResult.data ?? [])
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
    if (!supabase || !canManage || !transferProgrammeId || !transferReason.trim()) return
    setBusy(true)
    setMessage('')
    const { error: transferError } = await supabase.rpc('transfer_college_student_programme', {
      p_student_id: student.id,
      p_programme_id: transferProgrammeId,
      p_reason: transferReason.trim(),
    })
    setBusy(false)
    if (transferError) {
      setIsError(true)
      setMessage(transferError.message)
      return
    }
    const nextProgramme = activeProgrammes.find((programme) => programme.id === transferProgrammeId)
    if (nextProgramme) {
      setStudents((current) => current.map((item) => item.id === student.id
        ? { ...item, programme: { id: nextProgramme.id, name: nextProgramme.name, code: nextProgramme.code } }
        : item))
    }
    setIsError(false)
    setMessage(`Course transfer recorded for ${student.student_number}. Their registration number is unchanged.`)
    setTransferringStudent('')
    setTransferProgrammeId('')
    setTransferReason('')
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
              const programme = relationValue(student.programme)
              return (
                <div key={student.id} className="p-4">
                <div className="flex items-center gap-3">
                  {student.photoUrl ? <img alt="" className="h-10 w-10 rounded-full object-cover" src={student.photoUrl} /> : <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800"><UserRound size={17} /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{profile?.full_name ?? 'Student'}</p>
                  <p className="mt-1 truncate text-[10px] text-slate-500">{student.student_number} · {programme?.code ?? ''} {programme?.name ?? 'Programme'} · {profile?.email ?? ''}</p>
                </div>
                <span className="hidden text-[10px] text-slate-500 sm:block">{student.student_status}</span>
                {canManage && <button className="secondary-button justify-center" disabled={busy} onClick={() => {
                  setTransferringStudent(transferringStudent === student.id ? '' : student.id)
                  setTransferProgrammeId('')
                  setTransferReason('')
                }} type="button">Transfer</button>}
                </div>
                {canManage && transferringStudent === student.id && (
                  <form className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] dark:bg-slate-800/60" onSubmit={(event) => {
                    event.preventDefault()
                    void transferStudent(student)
                  }}>
                    <label className="block text-[11px] font-semibold">
                      New course
                      <select className="form-input mt-1" required value={transferProgrammeId} onChange={(event) => setTransferProgrammeId(event.target.value)}>
                        <option value="">Choose an active course</option>
                        {activeProgrammes.filter((item) => item.id !== relationValue(student.programme)?.id).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                      </select>
                    </label>
                    <label className="block text-[11px] font-semibold">
                      Authorized transfer reason
                      <input className="form-input mt-1" maxLength={500} required value={transferReason} onChange={(event) => setTransferReason(event.target.value)} />
                    </label>
                    <button className="primary-button h-10 justify-center self-end" disabled={busy} type="submit">{busy ? 'Saving…' : 'Record transfer'}</button>
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

export function StaffPage() {
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      const client = supabase
      if (!client) return
      const { data, error: queryError } = await client
        .from('college_staff')
        .select('id,staff_number,job_title,employment_status,phone,photo_path,profile:college_profiles!college_staff_id_fkey(full_name,email,role),department:college_departments(name)')
        .order('staff_number')
      if (!active) return
      if (queryError) {
        setError(queryError.message)
      } else {
        try {
          const records = (data ?? []) as StaffDirectoryEntry[]
          const rows = await Promise.all(records.map(async (row) => {
            if (!row.photo_path) return row
            const { data: photo, error: signedError } = await client.storage.from(bucket).createSignedUrl(row.photo_path, 300)
            if (signedError) throw signedError
            return { ...row, photoUrl: photo.signedUrl }
          }))
          if (active) setStaff(rows)
        } catch (error) {
          if (active) setError(error instanceof Error ? error.message : 'Could not load staff photos.')
        }
      }
      if (active) setLoading(false)
    }
    void load()
    return () => { active = false }
  }, [])

  return (
    <div className="mx-auto max-w-5xl">
      <h2 className="text-2xl font-bold tracking-tight">Staff</h2>
      <p className="mt-2 text-sm text-slate-500">Approved lecturers and non-teaching staff.</p>
      {error && <div className="mt-5"><FormMessage error message={error} /></div>}
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
        ) : <p className="p-8 text-center text-sm text-slate-500">No approved staff yet. Use Registration review to process applications.</p>}
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
