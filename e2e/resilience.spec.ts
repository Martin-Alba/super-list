import { test, expect } from '@playwright/test'
import { createUser, makeGroup, addActiveMember, signedInContext, api } from './fixtures'

/**
 * I6 (DoD 30) y I7 (DoD 31). Se corta la red de verdad con `setOffline`: nada
 * de simular el canal: se rompe la conexión igual que en un ascensor o un
 * supermercado con mala cobertura, que es el escenario real de esta app.
 */
test('el canal caído se anuncia, y al volver se recupera lo perdido', async ({ browser }) => {
  const owner = await createUser('res-owner')
  const member = await createUser('res-member')
  const { groupId, client } = await makeGroup(owner)
  await addActiveMember(owner, groupId, member)
  await client.from('items').insert({ group_id: groupId, name: 'pan', created_by: owner.id })

  const ctx = await signedInContext(browser, member)
  const page = await ctx.newPage()
  await page.goto(`/g/${groupId}`)
  await expect(page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('pan')
  await expect(page.getByTestId('channel-degraded')).toHaveCount(0)

  // DoD 30 — sin señal, la lista se congela y el usuario cree que está al día.
  await ctx.setOffline(true)
  await expect(page.getByTestId('channel-degraded')).toBeVisible({ timeout: 30_000 })

  // Mientras está desconectado, otro miembro añade algo: ese evento no le llega
  // a nadie que no esté escuchando.
  const ownerApi = await api(owner)
  await ownerApi.from('items').insert({ group_id: groupId, name: 'leche', created_by: owner.id })

  // DoD 31 — al recuperar el canal se relee: sin `onResync`, ese ítem quedaría
  // perdido para siempre en esta sesión, y dos personas comprando divergirían
  // de forma permanente.
  await ctx.setOffline(false)
  await expect(page.getByTestId('channel-degraded')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('item')).toHaveCount(2, { timeout: 30_000 })

  await ctx.close()
})
