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
  /**
   * Spec H — **acotada a los grupos vivos, y el motivo importa.** Un grupo borrado tiene, por
   * definición, cero owners activos: `delete_group` pone `removed` en toda membresía, el owner
   * incluido. Sin acotar, esta guarda se ponía roja sobre la conducta correcta —medido: 16 grupos en
   * la primera corrida— y eso acaba en que alguien la relaja o la borra.
   *
   * Lo que la acota es `deleted_at`, que existe **sólo para esto**: distinguir «borrado a propósito»
   * de «huérfano por un defecto». No es una puerta de acceso —`is_active_member` no lo consulta y
   * ninguna política lo menciona— y no abre un deshacer.
   */
  const huerfanos = () => sql<{ id: string }>(`
    select g.id from public.groups g
    where g.deleted_at is null
      and not exists (
        select 1 from public.group_members m
        where m.group_id = g.id and m.role='owner' and m.status='active')`)

  it('no existe ningún grupo VIVO sin owner activo', async () => {
    expect(await huerfanos(), 'hay grupos vivos sin dueño').toEqual([])
  })

  it('y la sonda: un huérfano sin marcador se caza', async () => {
    /**
     * §E.2 — Sobre una base sana el barrido de arriba no distingue «detecta» de «no mira nada», y
     * ahora menos que antes: acabo de añadirle una condición que podría excluirlo todo. Esto fabrica
     * el estado exacto que la guarda debe cazar —cero owners activos y `deleted_at` nulo— con la
     * clave de servicio, y exige que lo encuentre.
     */
    const owner = await newUser('cg-sonda'); const gid = await newGroup(owner)
    await sql("update public.group_members set status='removed' where group_id=$1", [gid])
    try {
      expect((await huerfanos()).map(r => r.id),
        'el barrido no caza un grupo vivo sin dueño').toContain(gid)
    } finally {
      // Se deja marcado, no se revierte: revertirlo devolvería el grupo a un estado que la guarda
      // prohíbe, y dejar basura que la rompe es el defecto que esta misma vuelta arregló en h4.
      await sql('update public.groups set deleted_at = now() where id=$1', [gid])
    }
    expect(await huerfanos(), 'la sonda dejó el árbol roto').toEqual([])
  })
})
