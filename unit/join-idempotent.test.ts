import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

// R5 / D.4 — sin ON CONFLICT sobre la PK el owner ve dos veces a la misma
// persona; sin la transición, el rechazado queda excluido para siempre.
describe('R5 solicitar ingreso es idempotente', () => {
  it('abrir el link dos veces deja UNA sola fila pending', async () => {
    const owner = await newUser('o'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('g')
    await guest.client.rpc('request_join', { p_token: token })
    await guest.client.rpc('request_join', { p_token: token })
    const rows = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    expect(rows).toEqual([{ status: 'pending' }])
  })

  it('un rechazado que reabre el link vuelve a pending', async () => {
    const owner = await newUser('o2'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('g2')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'rejected' })
    await guest.client.rpc('request_join', { p_token: token })
    const rows = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    expect(rows).toEqual([{ status: 'pending' }])
  })

  it('un miembro activo que reabre el link NO vuelve a pending', async () => {
    const owner = await newUser('o3'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('g3')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
    const { data } = await guest.client.rpc('request_join', { p_token: token })
    expect(data.status).toBe('active')
    const rows = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    expect(rows).toEqual([{ status: 'active' }])
  })

  it('aprobar dos veces deja el mismo resultado que aprobar una', async () => {
    const owner = await newUser('o4'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('g4')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
    const rows = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    expect(rows).toEqual([{ status: 'active' }])
  })

  // I15 — declarado: expulsar no devuelve el acceso. Con un link vigente el
  // expulsado puede volver a PEDIR, y el owner vuelve a ser la puerta (A.2).
  it('un expulsado que reabre un link vigente queda pending, no active', async () => {
    const owner = await newUser('o6'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('g6')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })

    const { data } = await guest.client.rpc('request_join', { p_token: token })
    expect(data.status).toBe('pending')
    const rows = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    expect(rows).toEqual([{ status: 'pending' }])
    const { data: items } = await guest.client.from('items').select('*').eq('group_id', gid)
    expect(items).toEqual([])
  })

  it('el owner no puede actuar sobre su propia membresía', async () => {
    const owner = await newUser('o5'); const gid = await newGroup(owner)
    const { error } = await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: owner.id, p_decision: 'removed' })
    expect(error).not.toBeNull()
  })
})
