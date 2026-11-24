import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const allowedOrigins = (Deno.env.get('STUDENT_LOGIN_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? ''
  if (!allowedOrigins.includes(origin)) {
    return new Response('Origin is not allowed.', { status: 403 })
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Student login requires Supabase URL, anon key, and service-role key secrets.')
    return new Response('Student sign-in is unavailable.', { status: 500, headers: corsHeaders })
  }

  let credentials: { student_number?: unknown; staff_number?: unknown; password?: unknown }
  try {
    credentials = await request.json()
  } catch {
    return new Response('Invalid sign-in request.', { status: 400, headers: corsHeaders })
  }

  const studentNumber = typeof credentials.student_number === 'string'
    ? credentials.student_number.trim().toUpperCase()
    : ''
  const staffNumber = typeof credentials.staff_number === 'string'
    ? credentials.staff_number.trim().toUpperCase()
    : ''
  const isStudentNumber = /^STJIT\/[A-Z0-9]{2,12}\/\d{4}\/\d{4}$/.test(studentNumber)
  const isStaffNumber = /^STJ-S-\d{4}-\d{6}$/.test(staffNumber)
  const password = typeof credentials.password === 'string' ? credentials.password : ''
  if ((!isStudentNumber && !isStaffNumber) || !password) {
    return new Response('Invalid college account number or password.', { status: 401, headers: corsHeaders })
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const auth = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let accountId: string | null = null
  if (isStudentNumber) {
    const { data: student, error: studentError } = await admin
      .from('college_students')
      .select('id')
      .eq('student_number', studentNumber)
      .maybeSingle()
    if (studentError) {
      console.error('Student number lookup failed:', studentError.message)
      return new Response('College account sign-in is unavailable.', { status: 500, headers: corsHeaders })
    }
    accountId = student?.id ?? null
  } else {
    const { data: staff, error: staffError } = await admin
      .from('college_staff')
      .select('id')
      .eq('staff_number', staffNumber)
      .maybeSingle()
    if (staffError) {
      console.error('Staff number lookup failed:', staffError.message)
      return new Response('College account sign-in is unavailable.', { status: 500, headers: corsHeaders })
    }
    accountId = staff?.id ?? null
  }

  if (!accountId) {
    return new Response('Invalid college account number or password.', { status: 401, headers: corsHeaders })
  }

  const { data: userResult, error: userError } = await admin.auth.admin.getUserById(accountId)
  if (userError) {
    console.error('College account lookup failed:', userError.message)
    return new Response('College account sign-in is unavailable.', { status: 500, headers: corsHeaders })
  }
  const email = userResult.user.email
  if (!email) {
    return new Response('Invalid college account number or password.', { status: 401, headers: corsHeaders })
  }

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({ email, password })
  if (signInError || !signIn.session) {
    return new Response('Invalid college account number or password.', { status: 401, headers: corsHeaders })
  }

  return Response.json({
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
  }, { headers: corsHeaders })
})
