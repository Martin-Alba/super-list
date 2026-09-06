import { describe, it, expect } from 'vitest'
import { newUser, newGroup } from './helpers'

/**
 * J8 / DoD 43 — `shares_active_group` exige que ambos sean `active`, así que el
 * owner leía "alguien" en cada solicitud y aprobaba a ciegas. A.2 le da la
 * llave del grupo; sin saber a quién abre, esa llave no significa nada.
 */
describe('J8 el owner ve a quién está aprobando', () => {
  it('el owner lee el nombre de un solicitante pending', async () => {
    const owner = await newUser('pp-owner')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('pp-guest')
    await guest.client.rpc('request_join', { p_token: token })

    const { data } = await owner.client.from('profiles').select('id, display_name').eq('id', guest.id)
    expect(data).toHaveLength(1)
    expect(data![0].display_name).toBe('Test pp-guest')
  })

  it('un miembro cualquiera NO lee el perfil de un pending: sólo el owner', async () => {
    const owner = await newUser('pp-owner2')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })

    const member = await newUser('pp-member')
    await member.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: member.id, p_decision: 'active' })

    const { data: token2 } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('pp-guest2')
    await guest.client.rpc('request_join', { p_token: token2 })

    const { data } = await member.client.from('profiles').select('id').eq('id', guest.id)
    expect(data, 'un miembro no-owner leyó el perfil de un solicitante').toEqual([])
  })

  // K6 / DoD 55 — J8 pidio ver a quien se APRUEBA. El permiso salio mas ancho:
  // el owner leia indefinidamente a quien ya habia expulsado, y A.1 cuenta a
  // `removed` como no-miembro.
  it('el owner NO lee el perfil de alguien a quien expulso', async () => {
    const owner = await newUser('pp-owner4')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('pp-guest4')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })

    const antes = await owner.client.from('profiles').select('id').eq('id', guest.id)
    expect(antes.data).toHaveLength(1)

    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })
    const despues = await owner.client.from('profiles').select('id').eq('id', guest.id)
    expect(despues.data, 'el owner sigue leyendo a un expulsado').toEqual([])
  })

  it('tampoco lee el perfil de alguien a quien rechazo', async () => {
    const owner = await newUser('pp-owner5')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('pp-guest5')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'rejected' })

    const { data } = await owner.client.from('profiles').select('id').eq('id', guest.id)
    expect(data).toEqual([])
  })

  it('el permiso no se extiende a desconocidos de otros grupos', async () => {
    const owner = await newUser('pp-owner3')
    await newGroup(owner)
    const stranger = await newUser('pp-stranger')

    const { data } = await owner.client.from('profiles').select('id').eq('id', stranger.id)
    expect(data).toEqual([])
  })
})
