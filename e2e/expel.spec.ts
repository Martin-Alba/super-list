import { test, expect } from '@playwright/test'
import { createUser, makeGroup, addActiveMember, signedInContext } from './fixtures'

// R7 — depende del evento positivo sobre la propia fila. Si la expulsión se
// implementara como borrado, B no recibiría nada y se quedaría leyendo.
test('el expulsado deja de ver el grupo sin recargar', async ({ browser }) => {
  const owner = await createUser('exp-owner')
  const member = await createUser('exp-member')
  const { groupId, client } = await makeGroup(owner)
  await addActiveMember(owner, groupId, member)
  await client.from('items').insert({ group_id: groupId, name: 'pan', created_by: owner.id })

  const ctxA = await signedInContext(browser, owner)
  const ctxB = await signedInContext(browser, member)
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await a.goto(`/g/${groupId}`)
  await b.goto(`/g/${groupId}`)
  await expect(b.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('pan')

  await a.getByTestId('expel').click()

  // I11 — separa "la expulsión no llegó a ocurrir" de "ocurrió y no se propagó".
  // Sin esto, una acción que falla en silencio se lee como un fallo del canal.
  await expect(a.getByTestId('notice')).toHaveCount(0)
  await expect(a.getByTestId('active-member')).toHaveCount(0)

  // Sin tocar nada en B: su vista deja de mostrar la lista.
  await expect(b.getByLabel('Nombre')).toHaveCount(0)
  await expect(b.getByTestId('items')).toHaveCount(0)

  await ctxA.close(); await ctxB.close()
})
