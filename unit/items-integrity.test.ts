import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

/**
 * J3 / DoD 37 — una política RLS no puede comparar la fila vieja con la nueva:
 * `USING` ve la vieja y `WITH CHECK` la nueva, nunca las dos. Por eso estos
 * invariantes viven en un trigger. Ambas escrituras estaban medidas como
 * posibles antes del cambio.
 */
async function groupWithItem() {
  const owner = await newUser('ii-owner')
  const gid = await newGroup(owner)
  const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
  const member = await newUser('ii-member')
  await member.client.rpc('request_join', { p_token: token })
  await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: member.id, p_decision: 'active' })
  const { data: item } = await owner.client.from('items')
    .insert({ group_id: gid, name: 'pan', created_by: owner.id }).select('id').single()
  return { owner, member, gid, itemId: item!.id as string }
}

describe('J3 integridad de los ítems', () => {
  it('un miembro no puede reescribir la autoría de un ítem ajeno', async () => {
    const { member, itemId } = await groupWithItem()
    const { error } = await member.client.from('items')
      .update({ created_by: member.id }).eq('id', itemId)
    expect(error, 'la autoría se dejó reescribir').not.toBeNull()

    const rows = await sql<{ created_by: string }>('select created_by from public.items where id=$1', [itemId])
    expect(rows[0].created_by).not.toBe(member.id)
  })

  it('un ítem borrado no resucita', async () => {
    const { owner, itemId } = await groupWithItem()
    await owner.client.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', itemId)

    const { error } = await owner.client.from('items').update({ deleted_at: null }).eq('id', itemId)
    expect(error, 'un borrado se pudo deshacer').not.toBeNull()

    const rows = await sql<{ deleted_at: string | null }>('select deleted_at from public.items where id=$1', [itemId])
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('un ítem no se puede mover a otro grupo', async () => {
    const { member, itemId } = await groupWithItem()
    const otherGroup = await newGroup(member, 'Otro')
    const { error } = await member.client.from('items').update({ group_id: otherGroup }).eq('id', itemId)
    expect(error).not.toBeNull()
  })

  // K11 / DoD 59 — `authenticated` tiene UPDATE de tabla y `created_at` es la
  // clave de ordenacion de la lista: reescribirlo reordena la compra para todo
  // el grupo, de forma permanente.
  it('created_at no se puede reescribir', async () => {
    const { member, itemId } = await groupWithItem()
    const { error } = await member.client.from('items')
      .update({ created_at: '2000-01-01T00:00:00Z' }).eq('id', itemId)
    expect(error, 'la clave de ordenacion se dejo reescribir').not.toBeNull()
  })

  it('lo legítimo sigue funcionando: renombrar y borrar', async () => {
    const { owner, itemId } = await groupWithItem()
    const renamed = await owner.client.from('items').update({ name: 'pan integral' }).eq('id', itemId).select('id')
    expect(renamed.error).toBeNull()
    const deleted = await owner.client.from('items')
      .update({ deleted_at: new Date().toISOString() }).eq('id', itemId).select('id')
    expect(deleted.error).toBeNull()
  })
})
