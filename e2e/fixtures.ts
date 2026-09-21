import type { Browser, BrowserContext, Page } from '@playwright/test'
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appHostname } from './appOrigin'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SECRET = process.env.SUPABASE_SECRET_KEY!

export const admin = createClient(URL, SECRET, { auth: { persistSession: false } })

export type TestUser = { id: string; email: string; password: string; name: string }

let seq = 0
export async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${seq++}@example.test`
  const password = 'test-password-1234'
  const name = `Test ${label}`
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: name },
  })
  if (error) throw error
  return { id: data.user!.id, email, password, name }
}

/**
 * Sesión real serializada por la propia @supabase/ssr — no se fabrican cookies
 * a mano. Google no se puede automatizar, pero lo que se prueba es el
 * comportamiento de esta app ante una sesión válida, no el login de Google.
 */
export async function signedInContext(browser: Browser, user: TestUser): Promise<BrowserContext> {
  const jar: { name: string; value: string }[] = []
  const client = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (toSet) => { jar.push(...toSet.map(c => ({ name: c.name, value: c.value }))) } },
  })
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw error
  const context = await browser.newContext()
  await context.addCookies(jar.map(c => ({ name: c.name, value: c.value, domain: appHostname(), path: '/' })))
  return context
}

/** Cliente autenticado como el usuario, para preparar estado sin pasar por la UI. */
export async function api(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw error
  return client
}

export async function makeGroup(owner: TestUser, name = 'Familia Alba') {
  const client = await api(owner)
  const { data, error } = await client.rpc('create_group', { p_name: name })
  if (error) throw error
  return { groupId: data as string, client }
}

export async function makeInvite(owner: TestUser, groupId: string): Promise<string> {
  const client = await api(owner)
  const { data, error } = await client.rpc('create_invite', { p_group_id: groupId })
  if (error) throw error
  return data as string
}

/**
 * Spec J / j15 — **El token del invite vivo de un grupo, leído por API.**
 *
 * Existe porque tres pruebas lo sacaban del `value` del campo de sólo lectura, y eso no era
 * una propiedad del producto: era un atajo del arnés apoyado en un detalle de presentación.
 * Quitar el campo las rompía a las tres sin que el producto perdiera nada.
 *
 * No sirve `makeInvite`: las dos de `avisos.spec.ts` generan el enlace **por la interfaz del
 * dueño a propósito**, porque `create_invite` comprueba `auth.uid()` y la clave de servicio no
 * tiene ninguna. Así que el gesto sigue siendo el de la interfaz y lo único que cambia es de
 * dónde lee el arnés: de la tabla, no de la pantalla.
 *
 * Espera, porque el click de la interfaz y esta lectura son dos eventos: sin el bucle, la
 * prueba corre antes de que el `insert` haya llegado y falla una vez de cada tantas.
 *
 * **Y el `limit(1)` sin orden es determinista por construcción, no por suerte**, que es la
 * clase de cosa que conviene dejar escrita antes de que un cuarto sitio lo use: `create_invite`
 * hace `update … set revoked_at = now() where revoked_at is null` **antes** de insertar, así
 * que nunca hay más de un invite vivo por grupo. Verificado en el catálogo, no recordado.
 */
export async function tokenVivo(groupId: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { data } = await admin.from('group_invites').select('token')
      .eq('group_id', groupId).is('revoked_at', null).limit(1)
    if (data?.length) return data[0].token as string
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`sin invite vivo para el grupo ${groupId} tras 5 s`)
}

/** Miembro activo listo para usar: solicita con el token y el owner aprueba. */
export async function addActiveMember(owner: TestUser, groupId: string, member: TestUser) {
  const token = await makeInvite(owner, groupId)
  const memberClient = await api(member)
  await memberClient.rpc('request_join', { p_token: token })
  const ownerClient = await api(owner)
  const { error } = await ownerClient.rpc('decide_member', {
    p_group_id: groupId, p_user_id: member.id, p_decision: 'active',
  })
  if (error) throw error
}

export const gotoGroup = (page: Page, id: string) => page.goto(`/g/${id}`)
