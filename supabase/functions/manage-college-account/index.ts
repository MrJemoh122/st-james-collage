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
    return response({ error: 'The account management function is not configured.' }, 500)
  }
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405)
  if (request.headers.get('origin') !== appOrigin) return response({ error: 'This portal origin is not allowed.' }, 403)

  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return response({ error: 'Sign in with a super-admin account.' }, 401)

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token)
  if (callerError || !callerData.user) return response({ error: 'The administrator session is invalid or expired.' }, 401)

  const { data: callerProfile, error: callerProfileError } = await callerClient
    .from('college_profiles')
    .select('role,is_suspended')
    .eq('id', callerData.user.id)
    .maybeSingle()
  if (callerProfileError) return response({ error: callerProfileError.message }, 500)
  if (callerProfile?.role !== 'super_admin' || callerProfile.is_suspended) {
    return response({ error: 'Only a super administrator can manage accounts.' }, 403)
  }

  let input: Record<string, unknown>
  try {
    const body: unknown = await request.json()
    if (!isRecord(body)) return response({ error: 'The request body must be a JSON object.' }, 400)
    input = body
  } catch {
    return response({ error: 'The request body must be valid JSON.' }, 400)
  }

  const action = input.action
  const targetUserId = typeof input.target_user_id === 'string' ? input.target_user_id : ''
  if (!['suspend', 'restore', 'delete'].includes(String(action))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return response({ error: 'Select a valid account and management action.' }, 400)
  }
  if (targetUserId === callerData.user.id) {
    return response({ error: 'You cannot suspend or delete your own account.' }, 403)
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: target, error: targetError } = await adminClient
    .from('college_profiles')
    .select('role,is_suspended')
    .eq('id', targetUserId)
    .maybeSingle()
  if (targetError) return response({ error: targetError.message }, 500)
  if (!target) return response({ error: 'The target account was not found.' }, 404)

  if (action === 'delete') {
    const { error: banError } = await adminClient.auth.admin.updateUserById(targetUserId, {
      ban_duration: '876000h',
    })
    if (banError) return response({ error: `Could not suspend the account before deletion: ${banError.message}` }, 400)

    const { data: filePathsData, error: prepareError } = await adminClient.rpc('stj_prepare_college_account_deletion', {
      p_actor_id: callerData.user.id,
      p_target_user_id: targetUserId,
    })
    if (prepareError) {
      if (!target.is_suspended) {
        const { error: rollbackError } = await adminClient.auth.admin.updateUserById(targetUserId, { ban_duration: 'none' })
        if (rollbackError) {
          return response({ error: `${prepareError.message} The account remains suspended because rollback failed: ${rollbackError.message}` }, 500)
        }
      }
      return response({ error: prepareError.message }, 400)
    }

    const filePaths = Array.isArray(filePathsData)
      ? filePathsData.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []
    if (filePaths.some((path) => !path.startsWith(`applications/${targetUserId}/`))) {
      return response({ error: 'The account is suspended and its personal database records were prepared for deletion, but a stored file path did not belong to this account.' }, 500)
    }
    for (let index = 0; index < filePaths.length; index += 100) {
      const { error: storageError } = await adminClient.storage
        .from('college-applications')
        .remove(filePaths.slice(index, index + 100))
      if (storageError) {
        return response({
          error: `The account is suspended and its personal database records have been removed, but some stored application files could not be deleted: ${storageError.message}`,
        }, 500)
      }
    }

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(targetUserId)
    if (deleteError) {
      return response({
        error: `Personal database records and files were removed, but the Auth account could not be deleted and remains suspended: ${deleteError.message}`,
      }, 500)
    }

    const { error: auditError } = await adminClient.from('college_audit_events').insert({
      actor_id: callerData.user.id,
      action: 'account.deleted',
      details: { previous_role: target.role, target_user_id: targetUserId },
    })
    if (auditError) {
      return response({ error: `The account was deleted, but the completion audit could not be recorded: ${auditError.message}` }, 500)
    }
    return response({ status: 'Account and personal records deleted. Shared institutional records were preserved.' }, 200)
  }

  const isSuspended = action === 'suspend'
  if (target.is_suspended === isSuspended) {
    return response({ status: isSuspended ? 'Account is already suspended.' : 'Account is already active.' }, 200)
  }

  const { error: authError } = await adminClient.auth.admin.updateUserById(targetUserId, {
    ban_duration: isSuspended ? '876000h' : 'none',
  })
  if (authError) return response({ error: authError.message }, 400)

  const { error: statusError } = await adminClient.rpc('stj_set_college_account_suspension', {
    p_actor_id: callerData.user.id,
    p_target_user_id: targetUserId,
    p_is_suspended: isSuspended,
  })
  if (statusError) {
    const { error: rollbackError } = await adminClient.auth.admin.updateUserById(targetUserId, {
      ban_duration: isSuspended ? 'none' : '876000h',
    })
    if (rollbackError) {
      return response({ error: `${statusError.message} Auth status rollback failed: ${rollbackError.message}` }, 500)
    }
    return response({ error: statusError.message }, 400)
  }

  return response({ status: isSuspended ? 'Account suspended.' : 'Account restored.' }, 200)
})
