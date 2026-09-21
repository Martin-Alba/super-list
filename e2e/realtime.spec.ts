import { test, expect } from '@playwright/test'
import { createUser, makeGroup, addActiveMember, signedInContext } from './fixtures'

// R9 — el requisito central, y el único que un test de un solo cliente no
// puede demostrar.
test('dos contextos: alta, edición y borrado llegan al otro sin recargar', async ({ browser }) => {
  const owner = await createUser('rt-owner')
  const member = await createUser('rt-member')
  const { groupId } = await makeGroup(owner)
  await addActiveMember(owner, groupId, member)

  const ctxA = await signedInContext(browser, owner)
  const ctxB = await signedInContext(browser, member)
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await a.goto(`/g/${groupId}`)
  await b.goto(`/g/${groupId}`)
  await expect(b.getByTestId('items')).toBeVisible()

  // ALTA
  await a.getByTestId('item-name').fill('zanahorias')
  await a.getByTestId('item-qty').fill('1 kg')
  await a.getByTestId('add-item').click()
  await expect(b.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('zanahorias')

  // EDICIÓN — DoD 24: el item que B tiene NACIO de un evento, no del render
  // del servidor. Con el campo no controlado, React fijaba la propiedad value
  // al crearlo y ningun cambio de props volvia a repintarlo: se renombraba en
  // el estado y no en la pantalla.
  const nameField = a.getByTestId('item').first().getByLabel('Nombre')
  await nameField.fill('zanahorias baby')
  await nameField.blur()
  await expect(b.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('zanahorias baby')

  // BORRADO — viaja como UPDATE de deleted_at, por eso va autorizado por RLS
  await a.getByTestId('delete-item').first().click()
  await expect(b.getByTestId('item')).toHaveCount(0)

  await ctxA.close(); await ctxB.close()
})

// J10 / DoD 45 — en tactil a 390 px el doble toque es el gesto accidental
// habitual, y sin deshabilitar el envio crea dos items identicos.
test('dos toques seguidos en anadir crean un solo item', async ({ browser }) => {
  const owner = await createUser('dbl-owner')
  const { groupId } = await makeGroup(owner)
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.goto(`/g/${groupId}`)

  await page.getByTestId('item-name').fill('cebollas')
  const boton = page.getByTestId('add-item')
  await boton.click({ clickCount: 2, delay: 20 })

  await expect(page.getByTestId('item')).toHaveCount(1)
  await ctx.close()
})
