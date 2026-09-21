'use server'

import { redirect } from 'next/navigation'
import { NOMBRE_VACIO, traducirConSesion, type Clase } from '@/lib/errors'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// I13/D.6 — ninguna llamada de red sin cota. Un upstream lento degrada; no
// cuelga la acción ni deja al usuario esperando sin respuesta.
const RPC_TIMEOUT_MS = 10_000
const bounded = () => AbortSignal.timeout(RPC_TIMEOUT_MS)

/**
 * S9 — La clase viaja con el texto. Sin ella, un fallo de sesión llegado desde
 * una acción de servidor mostraba "Tu sesión ha caducado" **sin** el enlace para
 * volver a entrar: el callejón exacto que R4 cierra en el otro camino.
 */
/**
 * AE2 — El campo se llamaba `error`, igual que el objeto crudo de la base, y por
 * eso ninguna guarda podía distinguirlos: uno es un mensaje ya traducido y el
 * otro es lo que Postgres escribió. Con nombres distintos, `error` en código de
 * producto significa **una sola cosa**, y la guarda de AE3 puede exigirle una
 * regla sin excepciones.
 */
export type ActionState = { mensaje?: string; clase?: Clase }

export async function createGroupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const name = String(formData.get('name') ?? '')
  if (!name.trim()) return { mensaje: NOMBRE_VACIO }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_group', { p_name: name }).abortSignal(bounded())
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
  redirect(`/g/${data}`)
}

export async function createInviteAction(groupId: string): Promise<ActionState & { token?: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_invite', { p_group_id: groupId }).abortSignal(bounded())
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
  revalidatePath(`/g/${groupId}`)
  return { token: data as string }
}

export async function decideMemberAction(
  groupId: string, userId: string, decision: 'active' | 'rejected' | 'removed',
): Promise<ActionState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('decide_member', {
    p_group_id: groupId, p_user_id: userId, p_decision: decision,
  }).abortSignal(bounded())
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
  revalidatePath(`/g/${groupId}`)
  return {}
}

/**
 * T9 — Lanzaba. Su traducción era letra muerta: Next enmascara el mensaje de una
 * Server Action con un digest, y no hay `error.tsx` en toda la app, así que el
 * usuario veía una pantalla de error en vez del aviso. Cierra la deuda 6, que
 * nombraba esto como la única de las cuatro acciones fuera del criterio común.
 */
export async function leaveGroupAction(groupId: string): Promise<ActionState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('leave_group', { p_group_id: groupId }).abortSignal(bounded())
  // R3 — traducido igual que las demás: el usuario no ve nombres de tablas.
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
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

/**
 * Spec H / H-R1 — Transferir la propiedad. El cliente manda intención, nunca autoridad (§B.5):
 * envía el grupo y la persona, y `transfer_group` deriva de la sesión si quien llama es el owner.
 * Nada de rol viaja desde aquí.
 */
export async function transferGroupAction(groupId: string, userId: string): Promise<ActionState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('transfer_group', {
    p_group_id: groupId, p_user_id: userId,
  }).abortSignal(bounded())
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
  revalidatePath(`/g/${groupId}`)
  return {}
}

/**
 * Spec H / H-R3 — Borrar el grupo, y **redirige**, como `leaveGroupAction`.
 *
 * La primera versión no redirigía, con el argumento de que el borrado pone la propia membresía en
 * `removed` y de esa transición ya se encarga la vista. Es verdad y no basta: esa transición llega
 * **por realtime**, así que con el canal degradado quien pulsa «Borrar» se queda mirando un grupo que
 * ya no existe sin que nada se mueva. Quien inicia una salida navega por su cuenta; el camino de la
 * vista sigue existiendo para los **demás** miembros, que no pulsaron nada.
 */
export async function deleteGroupAction(groupId: string): Promise<ActionState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('delete_group', { p_group_id: groupId }).abortSignal(bounded())
  if (error) return traducirConSesion(error, () => supabase.auth.getUser())
  revalidatePath('/')
  redirect('/')
}
