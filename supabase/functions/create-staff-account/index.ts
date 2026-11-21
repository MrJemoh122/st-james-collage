import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const appUrl = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '')
let appOrigin = ''
try {
  if (appUrl) appOrigin = new URL(appUrl).origin
} catch {
  console.error('APP_URL must be an absolute portal URL.')
}
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': appOrigin,
  'Vary': 'Origin',
}

function response(body: Record<string, string>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

Deno.serve(async (request) => {
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !appUrl || !appOrigin) {
    return response({ error: 'The staff invitation function is not configured.' }, 500)
  }
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405)
  if (request.headers.get('origin') !== appOrigin) return response({ error: 'This portal origin is not allowed.' }, 403)

  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return response({ error: 'Sign in with an authorized administrator account.' }, 401)

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token)
  if (callerError || !callerData.user) return response({ error: 'The administrator session is invalid or expired.' }, 401)

  const { data: profile, error: profileError } = await callerClient
    .from('college_profiles')
    .select('role')
    .eq('id', callerData.user.id)
    .maybeSingle()
  if (profileError) return response({ error: profileError.message }, 500)
  if (!profile || !['super_admin', 'college_admin', 'academic_registrar'].includes(profile.role)) {
    return response({ error: 'You are not allowed to create staff accounts.' }, 403)
  }

  let input: Record<string, unknown>
  try {
    const body: unknown = await request.json()
    if (!isRecord(body)) {
      return response({ error: 'The request body must be a JSON object.' }, 400)
    }
    input = body
  } catch {
    return response({ error: 'The request body must be valid JSON.' }, 400)
  }

  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : ''
  const phone = typeof input.phone === 'string' ? input.phone.trim() : ''
  const staffType = input.staff_type === 'lecturer' || input.staff_type === 'non_teaching_staff'
    ? input.staff_type
    : ''
  const departmentId = input.department_id
  const jobTitle = typeof input.job_title === 'string' ? input.job_title.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || fullName.length < 3 || fullName.length > 120
      || phone.length < 5 || phone.length > 30
      || !staffType
      || typeof departmentId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(departmentId)
      || jobTitle.length < 2 || jobTitle.length > 120) {
    return response({ error: 'Enter a valid email, name, phone, staff type, active department, and job title.' }, 400)
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: invitation, error: invitationError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: appUrl,
  })
  if (invitationError) return response({ error: invitationError.message }, 400)
  if (!invitation.user) return response({ error: 'The invitation did not return a user account.' }, 500)

  const { data: staffNumber, error: createError } = await adminClient.rpc('create_college_staff_account', {
    p_actor_id: callerData.user.id,
    p_user_id: invitation.user.id,
    p_staff_type: staffType,
    p_department_id: departmentId,
    p_job_title: jobTitle,
    p_phone: phone,
  })
  if (createError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(invitation.user.id)
    const cleanup = cleanupError ? ` Invitation cleanup also failed: ${cleanupError.message}` : ''
    return response({ error: `Could not create the staff record: ${createError.message}${cleanup}` }, 500)
  }

  return response({ staff_number: String(staffNumber) }, 201)
})
