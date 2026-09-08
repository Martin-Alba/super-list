import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'
import { softDeleteItem, updateItem } from '../lib/items'

// Borde 8 — un UPDATE sin filtrar deleted_at resucita el ítem para todos.
describe('editar un ítem ya borrado', () => {
  it('no afecta ninguna fila y no informa éxito', async () => {
    const owner = await newUser('e1'); const gid = await newGroup(owner)
    const { data: ins } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'setas', created_by: owner.id }).select('id').single()
    await softDeleteItem(owner.client, ins!.id)

    const { data: fila, clase } = await updateItem(owner.client, ins!.id, { name: 'setas portobello' })
    expect(clase).toBeNull()
    // W7 — `updateItem` devuelve la FILA: ausente significa que no se tocó
    // ninguna, que era lo que antes decía el recuento a 0.
    expect(fila).toBeNull()

    const rows = await sql('select name from public.items where id=$1', [ins!.id])
    expect(rows[0].name).toBe('setas')
  })
})
