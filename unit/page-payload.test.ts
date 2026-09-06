import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { newUser, newGroup } from './helpers'
import { loadGroupPayload } from '../lib/groupPayload'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * J5 / DoD 40 — la versión anterior de este test reejecutaba una *copia* de la
 * consulta: si la página volviera al `select` suelto de `profiles`, seguiría
 * verde. Ahora llama a la misma función que llama la página, y además
 * comprueba que la página sigue delegando en ella.
 */
describe('J5 el payload de la página no lleva a nadie de fuera del grupo', () => {
  it('la página delega en loadGroupPayload', () => {
    const src = readFileSync('app/g/[id]/page.tsx', 'utf8')
    expect(src).toContain('loadGroupPayload')
    // Control positivo: el patrón detecta la vuelta atrás.
    expect(src).not.toMatch(/from\('profiles'\)/)
  })

  it('sólo viajan los perfiles de los miembros de ese grupo', async () => {
    const owner = await newUser('pl-owner')
    const other = await newUser('pl-other')
    const gidA = await newGroup(owner, 'Grupo A')
    const gidB = await newGroup(owner, 'Grupo B')

    // `other` sólo entra en B: comparte grupo con el owner, pero no el A.
    const { data: tokenB } = await owner.client.rpc('create_invite', { p_group_id: gidB })
    await other.client.rpc('request_join', { p_token: tokenB })
    await owner.client.rpc('decide_member', { p_group_id: gidB, p_user_id: other.id, p_decision: 'active' })

    const payload = await loadGroupPayload(owner.client, gidA)

    expect(payload.group?.name).toBe('Grupo A')
    expect(payload.members.map(m => m.user_id)).toEqual([owner.id])
    expect(payload.profiles.map(p => p.id)).toEqual([owner.id])
    expect(JSON.stringify(payload), 'un no-miembro viajó en el payload').not.toContain(other.id)
  })

  it('en el grupo compartido sí viajan los dos, con nombre', async () => {
    const owner = await newUser('pl-owner2')
    const member = await newUser('pl-member2')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    await member.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: member.id, p_decision: 'active' })

    const payload = await loadGroupPayload(owner.client, gid)
    expect(payload.profiles.map(p => p.id).sort()).toEqual([owner.id, member.id].sort())
    expect(payload.profiles.every(p => p.display_name)).toBe(true)
  })
})

describe('K3 un fallo de consulta no se lee como "no hay nadie"', () => {
  it('con la red caída, el payload lo dice en vez de devolver listas vacías', async () => {
    // Cliente REAL de supabase-js con la red rota: es el modo de avería que la
    // cota de `boundedFetch` produce cuando el upstream no responde. No se
    // simula la biblioteca, sólo se le quita la red.
    const roto = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false }, global: { fetch: () => Promise.reject(new Error('network aborted')) } },
    )

    const payload = await loadGroupPayload(roto, '00000000-0000-4000-8000-000000000000')
    expect(payload.error, 'el fallo se perdió y quedó como lista vacía').toBeTruthy()
    expect(payload.members).toEqual([])
    expect(payload.items).toEqual([])
  })

  // L3 / DoD 65 — antes los dos casos daban `group: null` y la pagina
  // respondia 404: a un miembro legitimo se le decia que su grupo no existe
  // por una caida pasajera.
  it('un fallo del grupo se distingue de un grupo que no existe', async () => {
    const roto = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false }, global: { fetch: () => Promise.reject(new Error('network aborted')) } },
    )
    const averiado = await loadGroupPayload(roto, '00000000-0000-4000-8000-000000000000')

    const owner = await newUser('pg-owner')
    await newGroup(owner)
    const inexistente = await loadGroupPayload(owner.client, '00000000-0000-4000-8000-000000000000')

    expect(averiado.group).toBeNull()
    expect(inexistente.group).toBeNull()
    // Mismo `group`, distinto `error`: eso es lo que la pagina necesita para
    // no responder 404 ante una averia.
    expect(averiado.error).toBeTruthy()
    expect(inexistente.error).toBeNull()
  })

  it('sin avería, el error es nulo', async () => {
    const owner = await newUser('pe-owner')
    const gid = await newGroup(owner)
    const payload = await loadGroupPayload(owner.client, gid)
    expect(payload.error).toBeNull()
  })
})
