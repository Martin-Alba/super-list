import { expect, onTestFinished } from 'vitest'
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

/**
 * Spec H / i2-R8 — Ayudantes compartidos por `grupo-vida` y `grupo-carreras`.
 *
 * Estaban duplicados en los dos ficheros, y el predicado «contar owners activos» llegó a tener dos
 * copias: la forma exacta que la iteración 1 eliminó para `divergentes` y que volvió a aparecer en
 * el fichero de al lado.
 */
export const miembroActivo = async (gid: string, uid: string) => {
  const { error } = await admin.from('group_members').insert({ group_id: gid, user_id: uid, status: 'active' })
  if (error) throw error
}

export const ownersActivos = async (gid: string) => {
  const r = await sql<{ n: string }>(
    "select count(*) as n from public.group_members where group_id=$1 and role='owner' and status='active'", [gid])
  return Number(r[0].n)
}

export const rolDe = (gid: string, uid: string) =>
  sql<{ role: string; status: string }>(
    'select role, status from public.group_members where group_id=$1 and user_id=$2', [gid, uid])

/** Lo que la limpieza encontró antes de reparar. */
export type Hallazgo = { owners: number; estabaBorrado: boolean; ownerIdDivergia: boolean }

/**
 * **Repara e informa.** Demostrar que un test se pone rojo exige revertir su mecanismo, y con el
 * mecanismo revertido el escenario produce exactamente el estado que el mecanismo impide — un grupo
 * vivo sin dueño, dos owners, `owner_id` divergente. Ese estado sobrevive a la corrida y pone rojas
 * a las guardas del invariante **en otros ficheros**, sin que nada señale de dónde salió. Ocurrió
 * cinco veces en esta spec.
 *
 * Así que se repara. Pero reparar y callar borra la prueba: esta función arregla justo los tres
 * estados que los tres barridos globales vigilan, así que no distinguiría «pasó» de «se rompió y yo
 * lo tapé». Por eso devuelve lo que encontró, y quien la llama lo afirma **fuera** del `finally`.
 */
export const dejarCoherente = async (gid: string): Promise<Hallazgo> => {
  const owners = await sql<{ user_id: string }>(
    "select user_id from public.group_members where group_id=$1 and role='owner' and status='active'", [gid])
  const g = await sql<{ owner_id: string; deleted_at: string | null }>(
    'select owner_id, deleted_at from public.groups where id=$1', [gid])
  const hallazgo: Hallazgo = {
    owners: owners.length,
    estabaBorrado: g[0]?.deleted_at != null,
    /**
     * **Sólo tiene sentido con exactamente un owner**, y eso hay que decirlo en vez de fabricar un
     * valor: sin owner activo no hay a quién deba apuntar `owner_id`, así que «divergencia» no está
     * definida. Lo que se arregla es la aserción, no el cálculo — ver `coherente`.
     */
    ownerIdDivergia: owners.length === 1 && g[0]?.owner_id !== owners[0].user_id,
  }
  /**
   * i3-R3 — **La reparación comprueba que reparó.** Ignoraba el `error` de sus dos `update`, así que
   * una reparación fallida devolvía un `Hallazgo` limpio y dejaba la base rota: el modo de fallo de
   * i2-R4 por la puerta de al lado. `miembroActivo`, dos funciones más arriba, sí lo comprobaba.
   */
  const { error } = owners.length === 1
    ? await admin.from('groups').update({ owner_id: owners[0].user_id, deleted_at: null }).eq('id', gid)
    : await admin.from('groups').update({ deleted_at: new Date().toISOString() }).eq('id', gid)
  if (error) throw new Error(`la reparación de ${gid} falló: ${error.message}`)
  return hallazgo
}

/**
 * i3-R4 — Lo que la limpieza debe encontrar cuando el producto se comportó. Vive aquí, y no en un
 * fichero de prueba, porque **los cuatro sitios que reparan tienen que afirmar lo mismo**: dos de
 * ellos miraban sólo el recuento de owners, y `dejarCoherente` pone `deleted_at: null` en silencio
 * cuando encuentra uno — así que un defecto que borrara un grupo conservando su dueño pasaba.
 */
export const coherente = (h: Hallazgo, borradoEsperado = false) => {
  expect(h.owners, 'el grupo no acabó con exactamente un owner activo').toBe(borradoEsperado ? 0 : 1)
  /**
   * i3-R5 — **La divergencia sólo se afirma donde puede fallar.** `ownerIdDivergia` sólo está
   * definida con exactamente un owner, y con `borradoEsperado` se afirma `owners === 0` en la línea
   * de arriba: afirmarla ahí era una línea que no podía ponerse roja, en dos de los cuatro sitios.
   * §E.3 — un test que no puede fallar ocupa el sitio del que sí probaría.
   */
  if (!borradoEsperado) {
    expect(h.ownerIdDivergia, '`groups.owner_id` divergía de la fila de owner').toBe(false)
  }
  expect(h.estabaBorrado, borradoEsperado
    ? 'el grupo debía quedar borrado y no lo estaba'
    : 'el grupo quedó marcado como borrado sin que nadie lo borrara').toBe(borradoEsperado)
}

/**
 * i4-R4 — **La reparación corre pase lo que pase, y la coherencia se afirma después.**
 *
 * Los cinco sitios que reparaban lo hacían con una sentencia final suelta: si fallaba una aserción
 * anterior —el caso exacto para el que la reparación existe— no se ejecutaba, y el estado envenenado
 * sobrevivía para poner rojas a `create-group.test.ts` y a `h15` en toda corrida posterior. Es la
 * cicatriz que esta spec documenta cinco veces y por la que ya se arreglaron `h4` y `h15 bis`.
 *
 * `onTestFinished` corre tras el caso gane o pierda, y conoce el grupo. La aserción va **dentro** del
 * gancho: si el cuerpo ya falló, ese fallo es el que se reporta; si el cuerpo pasó, la coherencia
 * puede tumbarlo aquí.
 */
export const limpiarAlTerminar = (gid: string, borradoEsperado = false) => {
  onTestFinished(async () => { coherente(await dejarCoherente(gid), borradoEsperado) })
}
