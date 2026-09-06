import { test, expect } from '@playwright/test'
import { createUser, makeGroup, makeInvite, signedInContext, api } from './fixtures'

// R6 — sin el paso de aprobación nada separa pending de active.
test('el owner ve el contador, aprueba, y recién entonces el invitado ve la lista', async ({ browser }) => {
  const owner = await createUser('appr-owner')
  const { groupId, client } = await makeGroup(owner)
  await client.from('items').insert({ group_id: groupId, name: 'leche', created_by: owner.id })
  const token = await makeInvite(owner, groupId)

  const guest = await createUser('appr-guest')
  const guestClient = await api(guest)
  await guestClient.rpc('request_join', { p_token: token })

  const guestCtx = await signedInContext(browser, guest)
  const guestPage = await guestCtx.newPage()
  await guestPage.goto(`/g/${groupId}`)
  await expect(guestPage.getByTestId('pending')).toBeVisible()

  const ownerCtx = await signedInContext(browser, owner)
  const ownerPage = await ownerCtx.newPage()
  await ownerPage.goto(`/g/${groupId}`)
  await expect(ownerPage.getByTestId('pending-count')).toHaveText('1')
  await ownerPage.getByTestId('approve').click()
  await expect(ownerPage.getByTestId('pending-request')).toHaveCount(0)

  // El invitado pasa de la espera a la lista sin recargar a mano.
  await expect(guestPage.getByTestId('items')).toBeVisible()
  await expect(guestPage.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('leche')

  await ownerCtx.close(); await guestCtx.close()
})

test('rechazar deja fuera al solicitante', async ({ browser }) => {
  const owner = await createUser('rej-owner')
  const { groupId } = await makeGroup(owner)
  const token = await makeInvite(owner, groupId)
  const guest = await createUser('rej-guest')
  const guestClient = await api(guest)
  await guestClient.rpc('request_join', { p_token: token })

  const ownerCtx = await signedInContext(browser, owner)
  const ownerPage = await ownerCtx.newPage()
  await ownerPage.goto(`/g/${groupId}`)
  await ownerPage.getByTestId('reject').click()
  await expect(ownerPage.getByTestId('pending-request')).toHaveCount(0)

  const guestCtx = await signedInContext(browser, guest)
  const guestPage = await guestCtx.newPage()
  const res = await guestPage.goto(`/g/${groupId}`)
  expect(res?.status()).toBe(404)

  await ownerCtx.close(); await guestCtx.close()
})
