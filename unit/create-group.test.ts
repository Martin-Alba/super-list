import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

// R3 — crear el grupo sin la membresía en la misma transacción deja un
// grupo que ni su creador puede ver.
describe('R3 crear grupo', () => {
  it('el creador queda owner y active', async () => {
    const owner = await newUser('owner')
    const gid = await newGroup(owner)
    const rows = await sql(
      'select status, role from public.group_members where group_id=$1 and user_id=$2', [gid, owner.id])
    expect(rows).toEqual([{ status: 'active', role: 'owner' }])
  })
  it('un nombre en blanco lo rechaza la base, no el cliente', async () => {
    const owner = await newUser('owner-blank')
    const { error } = await owner.client.rpc('create_group', { p_name: '   ' })
    expect(error).not.toBeNull()
  })
  it('no existe ningún grupo sin owner activo', async () => {
    const rows = await sql(`
      select g.id from public.groups g
      where not exists (
        select 1 from public.group_members m
        where m.group_id = g.id and m.role='owner' and m.status='active')`)
    expect(rows).toEqual([])
  })
})
