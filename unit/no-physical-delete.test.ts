import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'
import { softDeleteItem } from '../lib/items'

// R16 / D.3 / B.3 — es el invariante que neutraliza la exención de RLS en
// los DELETE. Un borrado real pasa todos los demás tests y abre la fuga.
/**
 * guarda-borrado: sonda RLS. Este fichero INTENTA borrar a propósito, con el
 * token del usuario, para comprobar que la base lo deniega — y afirma que la
 * fila sigue existiendo. No es un borrado del arnés: es la prueba de que no
 * se puede borrar. Sin esta marca, `unit/harness-no-delete.test.ts` lo trata
 * como infracción, que es lo correcto por defecto.
 */
describe('R16 sin borrado físico en tablas publicadas', () => {
  it('ninguna tabla publicada tiene política DELETE', async () => {
    // Guarda contra el pase vacuo: si no hay tablas publicadas, la ausencia
    // de políticas DELETE no significa nada.
    const published = await sql(`
      select tablename from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public'`)
    expect(published.length, 'no hay tablas publicadas').toBeGreaterThan(0)
    const rows = await sql(`
      select p.tablename from pg_policies p
       where p.schemaname='public' and p.cmd='DELETE'
         and p.tablename in (
           select tablename from pg_publication_tables
            where pubname='supabase_realtime' and schemaname='public')`)
    expect(rows).toEqual([])
  })

  it('un miembro no puede borrar físicamente un ítem', async () => {
    const owner = await newUser('d1'); const gid = await newGroup(owner)
    const { data: ins } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pollo', created_by: owner.id }).select('id').single()
    // borrado-permitido: sonda RLS — intenta borrar para comprobar que la base lo deniega
    await owner.client.from('items').delete().eq('id', ins!.id)
    const rows = await sql('select 1 from public.items where id=$1', [ins!.id])
    expect(rows, 'el DELETE físico llegó a ejecutarse').toHaveLength(1)
  })

  it('tras expulsar y borrar un ítem, ambas filas siguen existiendo', async () => {
    const owner = await newUser('d2'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('d3')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })
    const { data: ins } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'arroz', created_by: owner.id }).select('id').single()

    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })
    await softDeleteItem(owner.client, ins!.id)

    const m = await sql('select status from public.group_members where group_id=$1 and user_id=$2', [gid, guest.id])
    const i = await sql('select deleted_at from public.items where id=$1', [ins!.id])
    expect(m).toEqual([{ status: 'removed' }])
    expect(i).toHaveLength(1)
    expect(i[0].deleted_at).not.toBeNull()
  })

  it('un miembro no puede borrar físicamente una membresía', async () => {
    const owner = await newUser('d4'); const gid = await newGroup(owner)
    // borrado-permitido: sonda RLS — intenta borrar para comprobar que la base lo deniega
    await owner.client.from('group_members').delete().eq('group_id', gid).eq('user_id', owner.id)
    const rows = await sql('select 1 from public.group_members where group_id=$1 and user_id=$2', [gid, owner.id])
    expect(rows).toHaveLength(1)
  })
})
