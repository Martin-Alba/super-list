import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

// R4 — sin comprobar revoked_at/expires_at en servidor el link viejo sigue
// sirviendo; y si las respuestas difieren, el token filtra si existió.
describe('R4 invitación revocable y con caducidad', () => {
  it('el token tiene al menos 128 bits de entropía', async () => {
    const owner = await newUser('inv')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    expect(String(token).length).toBeGreaterThanOrEqual(32) // hex: 48 chars = 192 bits
  })

  it('regenerar revoca el anterior de forma inmediata', async () => {
    const owner = await newUser('inv2')
    const gid = await newGroup(owner)
    const { data: first } = await owner.client.rpc('create_invite', { p_group_id: gid })
    await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('guest')
    const { data } = await guest.client.rpc('request_join', { p_token: first })
    expect(data.status).toBe('invalid')
  })

  // K4 / DoD 53 — medido antes del cambio: p_ttl_days = 3 650 000 acunaba un
  // link que caducaba en el ano 12020. R4 promete caducidad, y el link es el
  // artefacto que se reenvia a desconocidos.
  it('un TTL desmesurado queda acotado a 30 dias', async () => {
    const owner = await newUser('ttl')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid, p_ttl_days: 3_650_000 })
    const rows = await sql<{ dias: string }>(
      "select extract(day from (expires_at - now()))::text as dias from public.group_invites where token=$1", [token])
    expect(Number(rows[0].dias)).toBeLessThanOrEqual(30)
  })

  it('un TTL de cero o negativo se sube a un dia', async () => {
    const owner = await newUser('ttl2')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid, p_ttl_days: -5 })
    const rows = await sql<{ futuro: boolean }>(
      'select (expires_at > now()) as futuro from public.group_invites where token=$1', [token])
    expect(rows[0].futuro).toBe(true)
  })

  it('sólo el owner puede invitar', async () => {
    const owner = await newUser('inv3')
    const gid = await newGroup(owner)
    const stranger = await newUser('stranger')
    const { error } = await stranger.client.rpc('create_invite', { p_group_id: gid })
    expect(error).not.toBeNull()
  })

  it('caducado, revocado, inexistente y malformado: misma respuesta y ninguna membresía', async () => {
    const owner = await newUser('inv4')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    await sql('update public.group_invites set expires_at = now() - interval \'1 day\' where token=$1', [token])

    const guest = await newUser('guest4')
    const responses = []
    for (const t of [token, 'no-existe', '', "'; drop table public.items; --"]) {
      const { data } = await guest.client.rpc('request_join', { p_token: t })
      responses.push(data.status)
    }
    expect(responses).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
    const rows = await sql('select 1 from public.group_members where user_id=$1', [guest.id])
    expect(rows).toEqual([])
  })
})
