import { describe, it, expect } from 'vitest'
import { newUser, newGroup } from './helpers'

// R10 / D.3 — ataca la base saltándose la UI. Sólo pasa si el aislamiento
// vive en RLS y no en el componente.
async function groupWithItem() {
  const owner = await newUser('own'); const gid = await newGroup(owner)
  const { error } = await owner.client.from('items').insert({ group_id: gid, name: 'leche', created_by: owner.id })
  if (error) throw error
  const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
  return { owner, gid, token: token as string }
}

describe('R10 aislamiento entre grupos', () => {
  it('un no-miembro no ve ningún ítem', async () => {
    const { gid } = await groupWithItem()
    const outsider = await newUser('out')
    const { data } = await outsider.client.from('items').select('*').eq('group_id', gid)
    expect(data).toEqual([])
  })

  it.each(['pending', 'rejected', 'removed'])('un %s no ve ningún ítem', async (target) => {
    const { owner, gid, token } = await groupWithItem()
    const guest = await newUser('guest')
    await guest.client.rpc('request_join', { p_token: token })
    if (target === 'rejected') {
      await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'rejected' })
    } else if (target === 'removed') {
      await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
      await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })
    }
    const { data } = await guest.client.from('items').select('*').eq('group_id', gid)
    expect(data).toEqual([])
  })

  it('un no-miembro tampoco ve el grupo ni sus miembros', async () => {
    const { gid } = await groupWithItem()
    const outsider = await newUser('out2')
    const g = await outsider.client.from('groups').select('*').eq('id', gid)
    const m = await outsider.client.from('group_members').select('*').eq('group_id', gid)
    expect(g.data).toEqual([])
    expect(m.data).toEqual([])
  })

  it('un no-miembro no puede escribir en el grupo', async () => {
    const { gid } = await groupWithItem()
    const outsider = await newUser('out3')
    const { error } = await outsider.client.from('items').insert({ group_id: gid, name: 'intruso', created_by: outsider.id })
    expect(error).not.toBeNull()
  })

  it('un pendiente SÍ ve su propia fila de membresía — es lo que le entrega su expulsión', async () => {
    const { gid, token } = await groupWithItem()
    const guest = await newUser('guest2')
    await guest.client.rpc('request_join', { p_token: token })
    const { data } = await guest.client.from('group_members').select('status').eq('group_id', gid).eq('user_id', guest.id)
    expect(data).toEqual([{ status: 'pending' }])
  })
})
