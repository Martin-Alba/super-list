import { test, expect } from '@playwright/test'
import { createUser, makeGroup, signedInContext } from './fixtures'

// R14 / borde 10 — un signOut sólo de cliente deja viva la cookie de servidor
// y la siguiente persona del móvil compartido entra como la anterior.
test('tras cerrar sesión no queda rastro del usuario anterior', async ({ browser }) => {
  const owner = await createUser('out-owner')
  const { groupId } = await makeGroup(owner, 'Casa')

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Casa' })).toBeVisible()

  await page.getByTestId('signout').click()
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Casa' })).toHaveCount(0)

  await page.goto(`/g/${groupId}`)
  await expect(page).toHaveURL(/\/login/)
  await ctx.close()
})
