import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'
import { activeItems, softDeleteItem } from '../lib/items'

// R8 — con validación sólo de cliente, una llamada directa a la API mete el
// nombre vacío.
describe('R8 lista compartida', () => {
  it('la base rechaza un nombre vacío o de sólo espacios', async () => {
    const owner = await newUser('it'); const gid = await newGroup(owner)
    for (const name of ['', '   ', '\t\n']) {
      const { error } = await owner.client.from('items').insert({ group_id: gid, name, created_by: owner.id })
      expect(error, `aceptó el nombre ${JSON.stringify(name)}`).not.toBeNull()
    }
  })

  it('registra quién creó el ítem', async () => {
    const owner = await newUser('it2'); const gid = await newGroup(owner)
    await owner.client.from('items').insert({ group_id: gid, name: 'pan', quantity: '2 kg', created_by: owner.id })
    const rows = await sql('select name, quantity, created_by from public.items where group_id=$1', [gid])
    expect(rows).toEqual([{ name: 'pan', quantity: '2 kg', created_by: owner.id }])
  })

  it('borrar es lógico: la fila sigue existiendo y sale de las lecturas', async () => {
    const owner = await newUser('it3'); const gid = await newGroup(owner)
    const { data: ins } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'huevos', created_by: owner.id }).select('id').single()
    await softDeleteItem(owner.client, ins!.id)

    const rows = await sql('select deleted_at from public.items where id=$1', [ins!.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).not.toBeNull()

    const visible = await activeItems(owner.client, gid)
    expect(visible.map(i => i.id)).not.toContain(ins!.id)
  })
})
