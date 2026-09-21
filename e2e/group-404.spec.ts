import { test, expect } from '@playwright/test'
import { createUser, makeGroup, signedInContext } from './fixtures'

// Borde 5 / A.3 — un 403 confirmaría que el grupo existe. Para quien no es
// miembro activo el grupo no existe.
test('un no-miembro recibe "no existe", no "prohibido"', async ({ browser }) => {
  const owner = await createUser('g404-owner')
  const { groupId } = await makeGroup(owner)
  const outsider = await createUser('g404-out')

  const context = await signedInContext(browser, outsider)
  const page = await context.newPage()
  const response = await page.goto(`/g/${groupId}`)

  expect(response?.status()).toBe(404)
  await expect(page.getByTestId('group-name')).toHaveCount(0)
  await context.close()
})
