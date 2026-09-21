import { describe, it, expect } from 'vitest'
import { newUser, newGroup } from './helpers'
import { addItem, softDeleteItem, updateItem } from '../lib/items'

/**
 * I11 (DoD 33) — la capa que usa la interfaz devuelve el error en vez de
 * tragárselo. Si lo descarta, el usuario ve su texto en pantalla y cree que se
 * guardó: es el "éxito falso" del borde 8 trasladado a la interfaz.
 */
describe('I11 las mutaciones denegadas devuelven el error', () => {
  it('un no-miembro que intenta añadir recibe un error, no un silencio', async () => {
    const owner = await newUser('me-owner')
    const gid = await newGroup(owner)
    const outsider = await newUser('me-out')

    const { data, clase } = await addItem(outsider.client, gid, outsider.id,
      { id: crypto.randomUUID(), nombre: 'intruso', cantidad: null })
    expect(clase, 'la denegación de RLS llegó como éxito').toBeTruthy()
    expect(data).toBeNull()
  })

  it('un expulsado que intenta editar recibe un error', async () => {
    const owner = await newUser('me-owner2')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('me-guest')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })

    const { data: item } = await guest.client.from('items')
      .insert({ group_id: gid, name: 'huevos', created_by: guest.id }).select('id').single()

    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })

    // RLS ya no le deja tocar la fila: el UPDATE no afecta a nadie. Lo que no
    // puede pasar es que la interfaz lo lea como guardado.
    const renamed = await updateItem(guest.client, item!.id, { name: 'huevos camperos' })
    const deleted = await softDeleteItem(guest.client, item!.id)
    // W7 — `updateItem` devuelve la FILA: ausente significa que no se tocó
    // ninguna. `softDeleteItem` sigue devolviendo el recuento.
    expect(renamed.data).toBeNull()
    expect(deleted.data).toBe(0)
  })

  it('el éxito no lleva error: la señal distingue de verdad', async () => {
    const owner = await newUser('me-owner3')
    const gid = await newGroup(owner)
    const { data, clase } = await addItem(owner.client, gid, owner.id,
      { id: crypto.randomUUID(), nombre: 'pan', cantidad: null })
    expect(clase).toBeNull()
    expect(data?.name).toBe('pan')
  })
})
