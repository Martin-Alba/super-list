import { test, expect } from '@playwright/test'
import { createUser, makeGroup, addActiveMember, signedInContext } from './fixtures'

// R15 / borde 11 — sin la política acotada, o el miembro no puede salir o
// puede tocar la fila de otro.
test('un miembro sale por su cuenta y deja de ver el grupo', async ({ browser }) => {
  const owner = await createUser('lv-owner')
  const member = await createUser('lv-member')
  const { groupId } = await makeGroup(owner)
  await addActiveMember(owner, groupId, member)

  const ctx = await signedInContext(browser, member)
  const page = await ctx.newPage()
  await page.goto(`/g/${groupId}`)
  await page.getByTestId('leave').click()
  await expect(page).toHaveURL(/\/$/)

  const res = await page.goto(`/g/${groupId}`)
  expect(res?.status()).toBe(404)
  await ctx.close()
})

test('el owner no dispone de la acción de salir', async ({ browser }) => {
  const owner = await createUser('lv-owner2')
  const { groupId } = await makeGroup(owner)
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.goto(`/g/${groupId}`)

  await expect(page.getByTestId('group-name')).toBeVisible()
  await expect(page.getByTestId('leave')).toHaveCount(0)
  await ctx.close()
})
