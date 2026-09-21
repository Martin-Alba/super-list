import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

// Borde 7 / D.2 — un patrón leer-modificar-escribir pierde una de las dos y
// nada más lo delata.
describe('altas simultáneas', () => {
  it('dos miembros agregan a la vez y sobreviven ambas', async () => {
    const owner = await newUser('c1'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const other = await newUser('c2')
    await other.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: other.id, p_decision: 'active' })

    await Promise.all([
      owner.client.from('items').insert({ group_id: gid, name: 'zanahorias', created_by: owner.id }),
      other.client.from('items').insert({ group_id: gid, name: 'cebollas', created_by: other.id }),
    ])
    const rows = await sql('select name from public.items where group_id=$1 order by name', [gid])
    expect(rows.map(r => r.name)).toEqual(['cebollas', 'zanahorias'])
  })
})
