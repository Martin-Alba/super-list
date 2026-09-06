import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Pool } from 'pg'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SECRET = process.env.SUPABASE_SECRET_KEY!

export const admin = createClient(URL, SECRET, { auth: { persistSession: false } })
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params)
  return r.rows as T[]
}

let seq = 0
/** Crea un usuario real y devuelve un cliente autenticado como él. */
export async function newUser(label = 'u') {
  const email = `${label}-${Date.now()}-${seq++}@example.test`
  const password = 'test-password-1234'
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: `Test ${label}`, avatar_url: 'https://example.test/a.png' },
  })
  if (error) throw error
  const client: SupabaseClient = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: data.user!.id, email, client }
}

/** Grupo creado por `owner` mediante el RPC transaccional. */
export async function newGroup(owner: Awaited<ReturnType<typeof newUser>>, name = 'Familia Alba') {
  const { data, error } = await owner.client.rpc('create_group', { p_name: name })
  if (error) throw error
  return data as string
}
