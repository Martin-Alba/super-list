import { describe, it, expect } from 'vitest'
import { newUser, newGroup } from './helpers'

/**
 * J7 / DoD 42 — sin cota, un miembro legítimo mete 200 000 caracteres y
 * Realtime los difunde a todos los suscriptores. Con 500 MB de base y 2 M de
 * mensajes al mes en el plan gratuito, es una palanca de agotamiento que no
 * necesita ni un atacante: basta un pegado accidental.
 */
describe('J7 cota de longitud en los textos', () => {
  it('rechaza un nombre de ítem de 201 caracteres y acepta 200', async () => {
    const owner = await newUser('ll-owner')
    const gid = await newGroup(owner)

    const tooLong = await owner.client.from('items')
      .insert({ group_id: gid, name: 'a'.repeat(201), created_by: owner.id })
    expect(tooLong.error, 'entró un nombre de 201 caracteres').not.toBeNull()

    const ok = await owner.client.from('items')
      .insert({ group_id: gid, name: 'a'.repeat(200), created_by: owner.id })
    expect(ok.error).toBeNull()
  })

  it('rechaza una cantidad de 51 caracteres y acepta 50', async () => {
    const owner = await newUser('ll-owner2')
    const gid = await newGroup(owner)

    const tooLong = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', quantity: 'q'.repeat(51), created_by: owner.id })
    expect(tooLong.error).not.toBeNull()

    const ok = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', quantity: 'q'.repeat(50), created_by: owner.id })
    expect(ok.error).toBeNull()
  })

  it('rechaza un nombre de grupo de 201 caracteres', async () => {
    const owner = await newUser('ll-owner3')
    const { error } = await owner.client.rpc('create_group', { p_name: 'g'.repeat(201) })
    expect(error).not.toBeNull()
  })

  it('el gigante de 200 000 caracteres que el review midió ya no entra', async () => {
    const owner = await newUser('ll-owner4')
    const gid = await newGroup(owner)
    const { error } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'x'.repeat(200_000), created_by: owner.id })
    expect(error).not.toBeNull()
  })
})
