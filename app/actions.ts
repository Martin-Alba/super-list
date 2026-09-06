'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// I13/D.6 — ninguna llamada de red sin cota. Un upstream lento degrada; no
// cuelga la acción ni deja al usuario esperando sin respuesta.
const RPC_TIMEOUT_MS = 10_000
const bounded = () => AbortSignal.timeout(RPC_TIMEOUT_MS)

export type ActionState = { error?: string }

export async function createGroupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const name = String(formData.get('name') ?? '')
  if (!name.trim()) return { error: 'El nombre no puede estar vacío.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_group', { p_name: name }).abortSignal(bounded())
  if (error) return { error: error.message }
  redirect(`/g/${data}`)
}

export async function createInviteAction(groupId: string): Promise<{ token?: string; error?: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_invite', { p_group_id: groupId }).abortSignal(bounded())
  if (error) return { error: error.message }
  revalidatePath(`/g/${groupId}`)
  return { token: data as string }
}

export async function decideMemberAction(groupId: string, userId: string, decision: 'active' | 'rejected' | 'removed') {
  const supabase = await createClient()
  const { error } = await supabase.rpc('decide_member', {
    p_group_id: groupId, p_user_id: userId, p_decision: decision,
  }).abortSignal(bounded())
  if (error) return { error: error.message }
  revalidatePath(`/g/${groupId}`)
  return {}
}

export async function leaveGroupAction(groupId: string): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('leave_group', { p_group_id: groupId }).abortSignal(bounded())
  if (error) throw new Error(error.message)
  redirect('/')
}

export async function requestJoinAction(token: string) {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('request_join', { p_token: token }).abortSignal(bounded())
  if (error) return { status: 'invalid' as const }
  return data as { status: 'invalid' | 'pending' | 'active'; group_id?: string }
}

// R14 — el signOut ocurre en el servidor: borra la cookie de sesión, no sólo
// el estado del cliente.
export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
