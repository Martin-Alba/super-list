import type { Browser, BrowserContext, Page } from '@playwright/test'
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
  await context.addCookies(jar.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
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
