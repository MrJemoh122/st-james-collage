import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  ArrowDownRight,
  ArrowRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileCheck2,
  GraduationCap,
  LayoutDashboard,
  Library,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react'
import { supabase } from './lib/supabase'
import { CreateAccount } from './features/account'
import {
  ApplicantPortal,
  DepartmentsPage,
  ProgrammesPage,
  RegistrationReviewPage,
  registrationAdminRoles,
  StaffPage,
  StudentsPage,
} from './features/registration'
import type { CollegeRole } from './features/registration'

const AttendancePage = lazy(async () => {
  const module = await import('./features/attendance')
  return { default: module.AttendancePage }
})

const modules = [
  { name: 'Overview', description: 'College operations at a glance', icon: LayoutDashboard },
  { name: 'Students', description: 'Student records and registration', icon: GraduationCap },
  { name: 'Staff', description: 'Staff profiles and departments', icon: Users },
  { name: 'Departments', description: 'Academic department management', icon: Building2 },
  { name: 'Programmes', description: 'Programme setup and admissions', icon: BookOpen },
  { name: 'Registrations', description: 'Review student and staff applications', icon: ClipboardList },
  { name: 'Academics', description: 'Courses, programmes and classes', icon: BookOpen },
  { name: 'Attendance', description: 'Class attendance and QR check-in', icon: ClipboardCheck },
  { name: 'Examinations', description: 'Exams, assessments and results', icon: FileCheck2 },
  { name: 'Finance', description: 'Fees, payments and balances', icon: CreditCard },
  { name: 'Library', description: 'Library catalogue and borrowing', icon: Library },
  { name: 'Timetable', description: 'Classes, rooms and schedules', icon: CalendarDays },
  { name: 'Reports', description: 'College reports and analytics', icon: BarChart3 },
]

const moduleAccess: Record<CollegeRole, string[]> = {
  pending: [],
  super_admin: modules.map((module) => module.name),
  college_admin: modules.map((module) => module.name),
  academic_registrar: modules.map((module) => module.name),
  department_head: ['Overview', 'Programmes', 'Academics', 'Examinations', 'Timetable', 'Reports'],
  lecturer: ['Overview', 'Academics', 'Attendance', 'Examinations', 'Timetable'],
  student: ['Overview', 'Academics', 'Attendance', 'Finance', 'Library', 'Timetable'],
  finance_accountant: ['Overview', 'Finance', 'Reports'],
  bursar: ['Overview', 'Finance', 'Reports'],
  librarian: ['Overview', 'Library'],
  examination_officer: ['Overview', 'Academics', 'Attendance', 'Examinations', 'Reports'],
  non_teaching_staff: ['Overview'],
}

const summary = [
  { label: 'Total students', detail: 'Across all programmes', icon: GraduationCap },
  { label: 'Active staff', detail: 'Teaching and administration', icon: Users },
  { label: 'Attendance today', detail: 'Across scheduled classes', icon: ClipboardCheck },
  { label: 'Fees collected', detail: 'Current academic year · TZS', icon: CreditCard },
]

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))
  const [role, setRole] = useState<CollegeRole | null>(null)
  const [roleLoading, setRoleLoading] = useState(false)
  const [roleError, setRoleError] = useState('')
  const [roleRefresh, setRoleRefresh] = useState(0)
  const [page, setPage] = useState('Overview')
  const [query, setQuery] = useState('')
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(
    () => window.localStorage.getItem('stjames-theme') === 'dark',
  )

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false)
      return
    }

    let active = true
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) console.error('Unable to restore the Supabase session:', error.message)
      if (active) {
        setUser(data.session?.user ?? null)
        setAuthLoading(false)
      }
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    window.localStorage.setItem('stjames-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    if (!user || !supabase) {
      setRole(null)
      setRoleError('')
      setRoleLoading(false)
      return
    }

    let active = true
    setRoleLoading(true)
    setRoleError('')
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('college_profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle()
        if (!active) return
        if (error) {
          setRoleError(error.message)
          setRole(null)
        } else if (!data) {
          setRoleError('Your account profile was not found. Ask the college administrator to verify the database setup.')
          setRole(null)
        } else if (!Object.hasOwn(moduleAccess, data.role)) {
          setRoleError('Your account has an unrecognized college role. Ask an administrator to verify your role assignment.')
          setRole(null)
        } else {
          setRole(data.role as CollegeRole)
        }
        setRoleLoading(false)
      } catch (error) {
        if (!active) return
        setRoleError(error instanceof Error ? error.message : 'Your college access could not be loaded.')
        setRole(null)
        setRoleLoading(false)
      }
    })()

    return () => { active = false }
  }, [user, roleRefresh])

  const visibleModules = useMemo(
    () => modules.filter((module) => role && moduleAccess[role]?.includes(module.name)),
    [role],
  )

  const filteredModules = useMemo(
    () =>
      visibleModules.filter((module) =>
        `${module.name} ${module.description}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query, visibleModules],
  )

  function navigate(name: string) {
    if (!visibleModules.some((module) => module.name === name) && name !== 'Settings') return
    setPage(name)
    setQuery('')
    setMobileSearchOpen(false)
    setMobileOpen(false)
  }

  if (authLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-500 dark:bg-slate-950">
        <div className="flex items-center gap-3 text-sm">
          <span className="loading-dot" />
          Restoring your secure session…
        </div>
      </div>
    )
  }

  if (!user) {
    return <SignIn />
  }

  if (roleLoading || (!role && !roleError)) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-500 dark:bg-slate-950">
        <div className="flex items-center gap-3 text-sm">
          <span className="loading-dot" />
          Loading your college access…
        </div>
      </div>
    )
  }

  if (roleError) {
    return <DatabaseSetupError message={roleError} />
  }

  if (role === 'pending') {
    return <ApplicantPortal key={`${user.id}-${roleRefresh}`} user={user} onRefresh={() => setRoleRefresh((value) => value + 1)} />
  }

  const activeModule = visibleModules.find((module) => module.name === page) ?? visibleModules[0] ?? modules[0]
  const PageIcon = activeModule.icon
  const canManageDepartments = role !== null && registrationAdminRoles.includes(role)

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {mobileOpen && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-slate-950/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-[76px] items-center justify-between border-b border-slate-100 px-6 dark:border-slate-800">
          <a className="flex items-center gap-3" href="#" onClick={() => navigate('Overview')}>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600 text-white">
              <GraduationCap size={22} strokeWidth={2.2} />
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">St James</span>
              <span className="block text-[11px] text-slate-500">College management</span>
            </span>
          </a>
          <button
            aria-label="Close navigation"
            className="icon-button md:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X size={19} />
          </button>
        </div>

        <div className="px-4 pt-6">
          <p className="section-label px-3">WORKSPACE</p>
          <nav aria-label="Main navigation" className="mt-2 space-y-1">
            {visibleModules.map((module) => {
              const Icon = module.icon
              const selected = page === module.name
              return (
                <button
                  key={module.name}
                  aria-current={selected ? 'page' : undefined}
                  className={`nav-item ${selected ? 'nav-item-active' : ''}`}
                  onClick={() => navigate(module.name)}
                >
                  <Icon size={18} strokeWidth={1.8} />
                  <span>{module.name}</span>
                  {module.name === 'Registrations' && (
                    <span className="ml-auto h-2 w-2 rounded-full bg-amber-400" />
                  )}
                </button>
              )
            })}
          </nav>
          {['super_admin', 'college_admin'].includes(role ?? '') && (
            <>
              <p className="section-label mb-2 mt-8 px-3">PREFERENCES</p>
              <button className={`nav-item ${page === 'Settings' ? 'nav-item-active' : ''}`} onClick={() => navigate('Settings')}>
                <Settings size={18} strokeWidth={1.8} />
                <span>Settings</span>
              </button>
            </>
          )}
        </div>

        <div className="mt-auto p-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <ShieldCheck size={18} />
            </div>
            <p className="mt-3 text-xs font-semibold">Secure by design</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
              Sign-in is handled by Supabase. Data access requires configured roles and database policies.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between px-2 text-[10px] text-slate-400">
            <span>ST JAMES COLLEGE</span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>

      <div className="min-h-screen md:pl-[264px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/90 sm:px-7 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <button
              aria-label="Open navigation"
              className="icon-button md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div className="hidden text-sm text-slate-400 sm:block">Workspace</div>
            <span className="hidden text-slate-300 sm:block">/</span>
            <h1 className="truncate text-sm font-semibold">{page === 'Overview' ? `${page} · ${role?.replaceAll('_', ' ')}` : page}</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              aria-label={mobileSearchOpen ? 'Close search' : 'Search modules'}
              className="icon-button lg:hidden"
              onClick={() => setMobileSearchOpen((value) => !value)}
            >
              {mobileSearchOpen ? <X size={18} /> : <Search size={18} />}
            </button>
            <label className="relative hidden w-48 lg:block xl:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                aria-label="Search college modules"
                className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:focus:ring-indigo-950"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search modules..."
                value={query}
              />
            </label>
            <button
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="icon-button"
              onClick={() => setDarkMode((value) => !value)}
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="relative">
              <button
                aria-expanded={profileOpen}
                aria-label="Account menu"
                className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-2.5 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800 sm:px-3"
                onClick={() => setProfileOpen((value) => !value)}
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                  {(user.email?.[0] ?? 'U').toUpperCase()}
                </span>
                <span className="hidden max-w-32 truncate text-xs font-medium sm:block">
                  {user.email}
                </span>
                <ChevronDown className="hidden text-slate-400 sm:block" size={14} />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                  <p className="truncate px-3 py-2 text-xs text-slate-500">{user.email}</p>
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                    onClick={async () => {
                      setProfileOpen(false)
                      const { error } = await supabase!.auth.signOut()
                      if (error) window.alert(`Could not sign out: ${error.message}`)
                    }}
                  >
                    <LogOut size={15} />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-7 sm:py-9 lg:px-10">
          {mobileSearchOpen && (
            <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 lg:hidden">
              <label className="relative block">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                  aria-label="Search college modules"
                  autoFocus
                  className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search modules..."
                  value={query}
                />
              </label>
              {query && <div className="mt-4"><SearchResults modules={filteredModules} onNavigate={navigate} /></div>}
            </div>
          )}
          {query && (
            <div className="mb-6 hidden rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 lg:block">
              <SearchResults modules={filteredModules} onNavigate={navigate} />
            </div>
          )}
          {page === 'Overview' ? (
            <Dashboard onNavigate={navigate} availableModules={visibleModules} />
          ) : page === 'Settings' ? (
            <SettingsPage darkMode={darkMode} onThemeChange={() => setDarkMode((value) => !value)} />
          ) : page === 'Students' ? (
            <StudentsPage />
          ) : page === 'Staff' ? (
            <StaffPage />
          ) : page === 'Departments' ? (
            <DepartmentsPage canManage={canManageDepartments} />
          ) : page === 'Programmes' ? (
            <ProgrammesPage canManage={canManageDepartments} />
          ) : page === 'Registrations' ? (
            <RegistrationReviewPage />
          ) : page === 'Attendance' ? (
            <Suspense fallback={<div className="grid min-h-64 place-items-center text-sm text-slate-500">Loading attendance…</div>}>
              <AttendancePage user={user} role={role!} />
            </Suspense>
          ) : (
            <ModulePage icon={PageIcon} module={activeModule} />
          )}
        </main>
        <footer className="border-t border-slate-200/80 px-4 py-5 text-center text-[11px] text-slate-400 dark:border-slate-800 sm:px-7 lg:px-10">
          St James College Institute of Technology <span className="mx-2">·</span> Management portal
        </footer>
      </div>
    </div>
  )
}

function DatabaseSetupError({ message }: { message: string }) {
  const [signOutError, setSignOutError] = useState('')

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-5 dark:bg-slate-950">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <ShieldCheck size={20} />
        </span>
        <h1 className="mt-4 text-lg font-bold">College access is not ready</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          The required database profile or role could not be loaded. Apply the reviewed Supabase migrations and verify this account before continuing.
        </p>
        <p className="mt-4 break-words rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{message}</p>
        {signOutError && <p className="mt-3 text-xs text-rose-600">{signOutError}</p>}
        <button
          className="secondary-button mt-5"
          onClick={async () => {
            const { error } = await supabase?.auth.signOut() ?? { error: new Error('Supabase is not configured.') }
            if (error) setSignOutError(error.message)
          }}
        >
          <LogOut size={14} /> Sign out
        </button>
      </section>
    </main>
  )
}

function SearchResults({
  modules: results,
  onNavigate,
}: {
  modules: typeof modules
  onNavigate: (name: string) => void
}) {
  return (
    <div>
      <p className="section-label mb-3">MODULES</p>
      {results.length ? (
        <div className="flex flex-wrap gap-2">
          {results.map((module) => (
            <button
              key={module.name}
              className="rounded-xl border border-slate-200 px-3 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:hover:bg-indigo-950/30"
              onClick={() => onNavigate(module.name)}
            >
              <span className="block text-xs font-semibold">{module.name}</span>
              <span className="mt-1 block text-[11px] text-slate-500">{module.description}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No modules match that search.</p>
      )}
    </div>
  )
}

function Dashboard({
  onNavigate,
  availableModules,
}: {
  onNavigate: (name: string) => void
  availableModules: typeof modules
}) {
  const today = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date())

  return (
    <>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium text-slate-500">{today}</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-[30px]">College overview</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            A clear view of academic and administrative operations.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Data modules need setup
        </span>
      </div>

      <div className="mt-7 flex flex-col gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/80 p-4 dark:border-indigo-900/70 dark:bg-indigo-950/30 sm:flex-row sm:items-center sm:p-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm dark:bg-slate-900 dark:text-indigo-300">
          <LockKeyhole size={19} />
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold">Your account is signed in securely</p>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-400">
            Student, finance and staff records will appear after the database schema, role permissions and Row Level Security policies are configured.
          </p>
        </div>
        <a
          className="inline-flex shrink-0 items-center gap-2 text-xs font-semibold text-indigo-700 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200"
          href="https://supabase.com/docs/guides/database/postgres/row-level-security"
          rel="noreferrer"
          target="_blank"
        >
          Security guide <ArrowRight size={14} />
        </a>
      </div>

      <section aria-label="College metrics" className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summary.map((item) => {
          const Icon = item.icon
          return (
            <article
              key={item.label}
              className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-start justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <Icon size={19} strokeWidth={1.8} />
                </span>
                <span className="rounded-lg bg-slate-50 px-2 py-1 text-[10px] text-slate-500 dark:bg-slate-800">
                  Not connected
                </span>
              </div>
              <p className="mt-5 text-2xl font-bold tracking-tight text-slate-300 dark:text-slate-600">—</p>
              <p className="mt-1 text-xs font-semibold">{item.label}</p>
              <p className="mt-1 text-[11px] text-slate-500">{item.detail}</p>
            </article>
          )
        })}
      </section>

      <div className="mt-7 grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold">Academic activity</h3>
              <p className="mt-1 text-xs text-slate-500">Recent activity will be shown here</p>
            </div>
            <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800">
              Live data pending
            </span>
          </div>
          <div className="mt-6 grid min-h-48 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-5 text-center dark:border-slate-700 dark:bg-slate-800/30">
            <div className="max-w-sm">
              <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white text-slate-400 shadow-sm dark:bg-slate-800">
                <CalendarDays size={18} />
              </span>
              <p className="mt-3 text-xs font-semibold">No academic data connected</p>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Once academic tables and access policies are in place, recent activity will appear in this space.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-bold">Quick access</h3>
              <p className="mt-1 text-xs text-slate-500">Explore college modules</p>
            </div>
            <ArrowDownRight className="text-slate-400" size={17} />
          </div>
          <div className="mt-4 space-y-2">
            {availableModules.filter((module) => module.name !== 'Overview').slice(0, 4).map((module) => {
              const Icon = module.icon
              return (
                <button
                  key={module.name}
                  className="group flex w-full items-center gap-3 rounded-xl p-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800"
                  onClick={() => onNavigate(module.name)}
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold">{module.name}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-slate-500">{module.description}</span>
                  </span>
                  <ArrowRight className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" size={15} />
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </>
  )
}

function ModulePage({
  icon: Icon,
  module,
}: {
  icon: typeof LayoutDashboard
  module: (typeof modules)[number]
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Icon size={23} />
        </span>
        <div>
          <p className="text-xs font-medium text-slate-500">College module</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">{module.name}</h2>
        </div>
      </div>
      <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
        <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Not configured
        </span>
        <h3 className="mt-5 text-lg font-bold">{module.description}</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
          This module is ready for integration, but there are no verified database tables or role policies available in this project yet. No sample records are shown as real college data.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="flex items-center gap-2 text-xs font-semibold">
              <LockKeyhole className="text-indigo-600 dark:text-indigo-300" size={15} />
              Data access
            </p>
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              Requires authorized roles and database Row Level Security.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="flex items-center gap-2 text-xs font-semibold">
              <CircleHelp className="text-indigo-600 dark:text-indigo-300" size={15} />
              Next step
            </p>
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              Confirm the existing schema and module permissions before enabling writes.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsPage({
  darkMode,
  onThemeChange,
}: {
  darkMode: boolean
  onThemeChange: () => void
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Personal preferences for this browser.
      </p>
      <section className="mt-7 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-sm font-semibold">Appearance</p>
            <p className="mt-1 text-xs text-slate-500">Choose light or dark display mode.</p>
          </div>
          <button className="secondary-button" onClick={onThemeChange}>
            {darkMode ? <Sun size={15} /> : <Moon size={15} />}
            {darkMode ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
        <div className="flex items-start gap-3 p-5">
          <Check className="mt-0.5 text-emerald-600" size={17} />
          <div>
            <p className="text-sm font-semibold">Supabase authentication</p>
            <p className="mt-1 text-xs text-slate-500">
              Authentication is enabled for this session. Role-based permissions and database access still need configuration.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setIsError(false)
    if (!supabase) {
      setIsError(true)
      setMessage('Supabase is not configured. Add the project URL and publishable key to .env.local.')
      return
    }
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setIsError(true)
      setMessage(error.message)
    }
  }

  async function resetPassword() {
    setMessage('')
    setIsError(false)
    if (!supabase) {
      setIsError(true)
      setMessage('Password reset is unavailable until Supabase is configured.')
      return
    }
    if (!email.trim()) {
      setIsError(true)
      setMessage('Enter your account email first.')
      return
    }
    setBusy(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`,
    })
    setBusy(false)
    setIsError(Boolean(error))
    setMessage(error ? error.message : 'If an account exists for this address, a reset link has been sent.')
  }

  return (
    <main className="grid min-h-screen bg-white dark:bg-slate-950 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden overflow-hidden bg-[#101735] p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full border border-white/10" />
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full border border-white/10" />
        <div className="absolute -bottom-48 -left-20 h-[480px] w-[480px] rounded-full bg-indigo-500/20 blur-3xl" />
        <a className="relative flex items-center gap-3" href="#">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-500 text-white">
            <GraduationCap size={23} />
          </span>
          <span>
            <span className="block text-sm font-bold">St James College</span>
            <span className="block text-xs text-slate-300">Institute of Technology</span>
          </span>
        </a>
        <div className="relative max-w-lg">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">One connected campus</p>
          <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight xl:text-5xl">
            A clearer view of college life.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-7 text-slate-300">
            A secure workspace for the people and processes that keep St James moving forward.
          </p>
          <div className="mt-10 flex items-center gap-3 text-xs text-slate-300">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10">
              <ShieldCheck size={16} />
            </span>
            Secure access for your college community
          </div>
        </div>
        <p className="relative text-[11px] text-slate-400">© {new Date().getFullYear()} St James College Institute of Technology</p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600 text-white">
              <GraduationCap size={22} />
            </span>
            <span>
              <span className="block text-sm font-bold">St James College</span>
              <span className="block text-xs text-slate-500">Institute of Technology</span>
            </span>
          </div>
          {creatingAccount ? (
            <CreateAccount onBack={() => setCreatingAccount(false)} />
          ) : (
            <>
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Welcome back</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight">Sign in to your account</h2>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Use your college-issued account to continue.
              </p>
              <form className="mt-8 space-y-5" onSubmit={submit}>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Email address</span>
                  <input
                    autoComplete="username"
                    className="form-input"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@college.edu"
                    required
                    type="email"
                    value={email}
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Password</span>
                  <input
                    autoComplete="current-password"
                    className="form-input"
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter your password"
                    required
                    type="password"
                    value={password}
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 disabled:opacity-50 dark:text-indigo-300"
                    disabled={busy}
                    onClick={resetPassword}
                    type="button"
                  >
                    Forgot password?
                  </button>
                </div>
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
                  {busy ? 'Please wait…' : 'Sign in'}
                  {!busy && <ArrowRight size={16} />}
                </button>
              </form>
              <p className="mt-6 text-center text-xs text-slate-500">
                New student or staff member?{' '}
                <button className="font-semibold text-indigo-700 hover:text-indigo-900 dark:text-indigo-300" onClick={() => setCreatingAccount(true)} type="button">
                  Create an account
                </button>
              </p>
              <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-slate-400">
                <LockKeyhole size={13} />
                Secure authentication powered by Supabase
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
