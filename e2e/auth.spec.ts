import { test, expect } from '@playwright/test'
import { createUser, makeGroup, signedInContext } from './fixtures'

// R1 / borde 6 — sin guarda ni conservación del destino, el usuario cae en la
// home tras loguearse en vez de en lo que pidió.
test('sin sesión, una ruta privada lleva a /login conservando el destino', async ({ page }) => {
  const owner = await createUser('auth-owner')
  const { groupId } = await makeGroup(owner)

  await page.goto(`/g/${groupId}`)
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fg%2F${groupId}`))
  await expect(page.getByTestId('google-signin')).toBeVisible()
})

test('con sesión válida se llega al grupo sin pasar por login', async ({ browser }) => {
  const owner = await createUser('auth-owner2')
  const { groupId } = await makeGroup(owner)
  const context = await signedInContext(browser, owner)
  const page = await context.newPage()

  await page.goto(`/g/${groupId}`)
  await expect(page.getByTestId('group-name')).toHaveText('Familia Alba')
  await context.close()
})

test('una sesión inválida se trata como ausencia de sesión', async ({ browser }) => {
  const owner = await createUser('auth-owner3')
  const { groupId } = await makeGroup(owner)
  const context = await signedInContext(browser, owner)
  const cookies = await context.cookies()
  await context.clearCookies()
  await context.addCookies(cookies.map(c => ({ ...c, value: 'basura-invalida' })))
  const page = await context.newPage()

  await page.goto(`/g/${groupId}`)
  await expect(page).toHaveURL(/\/login/)
  await context.close()
})
