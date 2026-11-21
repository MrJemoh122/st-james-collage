import { useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function CreateAccount({ onBack }: { onBack: () => void }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    if (!supabase) {
      setIsError(true)
      setMessage('Supabase is not configured. Add the project URL and publishable key before creating an account.')
      return
    }
    if (password.length < 12) {
      setIsError(true)
      setMessage('Use a password with at least 12 characters.')
      return
    }

    setBusy(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      })
      if (error) throw error
      setPassword('')
      setMessage(
        data.session
          ? 'Account created. Continue to the applicant portal to complete registration.'
          : 'Account created. Check your email to confirm the address, then sign in to complete registration.',
      )
    } catch (error) {
      setIsError(true)
      setMessage(error instanceof Error ? error.message : 'Account creation failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button className="mb-7 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-indigo-700 dark:hover:text-indigo-300" onClick={onBack} type="button">
        <ArrowLeft size={14} /> Back to sign in
      </button>
      <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">New applicant</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight">Create an account</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
        Create a secure sign-in to apply for student admission. Lecturer and staff accounts are created by an administrator and activated through a secure email invitation.
      </p>
      <form className="mt-8 space-y-5" onSubmit={submit}>
        <label className="block">
          <span className="mb-2 block text-xs font-semibold">Full name</span>
          <input
            autoComplete="name"
            className="form-input"
            maxLength={120}
            onChange={(event) => setFullName(event.target.value)}
            required
            value={fullName}
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-xs font-semibold">Email address</span>
          <input
            autoComplete="email"
            className="form-input"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-xs font-semibold">Password</span>
          <input
            autoComplete="new-password"
            className="form-input"
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <span className="mt-1.5 block text-[10px] text-slate-500">At least 12 characters.</span>
        </label>
        {message && (
          <p
            aria-live="polite"
            className={`rounded-xl px-3 py-2.5 text-xs leading-5 ${
              isError
                ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            }`}
          >
            {message}
          </p>
        )}
        <button className="primary-button h-11 w-full justify-center" disabled={busy} type="submit">
          {busy ? <><LoaderCircle className="animate-spin" size={16} /> Creating account…</> : <>Create account <ArrowRight size={16} /></>}
        </button>
      </form>
    </div>
  )
}
