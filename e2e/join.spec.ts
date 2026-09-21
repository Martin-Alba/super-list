import { test, expect } from '@playwright/test'
import { createUser, makeGroup, makeInvite, signedInContext, api } from './fixtures'

// R5 / borde 2 — si el pendiente ve la lista, la aprobación no es una puerta.
test('el invitado queda en espera y NO ve ningún ítem', async ({ browser }) => {
  const owner = await createUser('join-owner')
  const { groupId, client } = await makeGroup(owner)
  await client.from('items').insert({ group_id: groupId, name: 'secreto', created_by: owner.id })
  const token = await makeInvite(owner, groupId)

  const guest = await createUser('join-guest')
  const context = await signedInContext(browser, guest)
  const page = await context.newPage()

  await page.goto(`/invite/${token}`)
  await expect(page.getByTestId('pending')).toBeVisible()
  await expect(page.getByLabel('Nombre')).toHaveCount(0)
  await expect(page.getByTestId('items')).toHaveCount(0)
  await context.close()
})

test('un miembro activo que abre el link entra directo, no vuelve a espera', async ({ browser }) => {
  const owner = await createUser('join-owner2')
  const { groupId } = await makeGroup(owner)
  const token = await makeInvite(owner, groupId)

  const context = await signedInContext(browser, owner)
  const page = await context.newPage()
  await page.goto(`/invite/${token}`)

  await expect(page).toHaveURL(new RegExp(`/g/${groupId}`))
  await expect(page.getByTestId('pending')).toHaveCount(0)
  await context.close()
})

test('sin sesión el link es público pero pide entrar conservando el token', async ({ page }) => {
  const owner = await createUser('join-owner3')
  const { groupId } = await makeGroup(owner)
  const token = await makeInvite(owner, groupId)

  await page.goto(`/invite/${token}`)
  await expect(page.getByTestId('invite-login')).toBeVisible()
  await page.getByTestId('invite-login').click()
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Finvite%2F${token}`))
})

test('un link revocado no deja pedir acceso', async ({ browser }) => {
  const owner = await createUser('join-owner4')
  const { groupId } = await makeGroup(owner)
  const stale = await makeInvite(owner, groupId)
  await makeInvite(owner, groupId) // regenerar revoca el anterior

  const guest = await createUser('join-guest4')
  const context = await signedInContext(browser, guest)
  const page = await context.newPage()
  await page.goto(`/invite/${stale}`)

  await expect(page.getByTestId('invite-invalid')).toBeVisible()
  const client = await api(guest)
  const { data } = await client.from('group_members').select('*').eq('group_id', groupId)
  expect(data).toEqual([])
  await context.close()
})
