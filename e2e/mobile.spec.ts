import { test, expect } from '@playwright/test'
import { createUser, makeGroup, makeInvite, addActiveMember, signedInContext } from './fixtures'

// R13 — un layout de escritorio pasa todo lo demás y falla sólo acá.
async function noHorizontalScroll(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth)
}

test('ninguna pantalla del flujo desborda a 390 px', async ({ browser }) => {
  const owner = await createUser('mob-owner')
  const member = await createUser('mob-member')
  const { groupId, client } = await makeGroup(owner, 'Familia Alba con nombre bastante largo')
  await addActiveMember(owner, groupId, member)
  await client.from('items').insert({
    group_id: groupId, created_by: owner.id,
    name: 'un producto con un nombre francamente larguísimo para forzar el desbordamiento',
    quantity: '12 unidades',
  })
  const token = await makeInvite(owner, groupId)

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()

  for (const path of ['/', `/g/${groupId}`]) {
    await page.goto(path)
    expect(await noHorizontalScroll(page), `${path} desborda a 390 px`).toBe(true)
  }

  await page.goto('/login')
  expect(await noHorizontalScroll(page), '/login desborda a 390 px').toBe(true)
  await ctx.close()

  // K14 / DoD 61 — visitada como owner, la pantalla de invitación redirige al
  // grupo y nunca llega a medirse: hacía falta alguien que NO sea miembro.
  const forastero = await createUser('mob-forastero')
  const ctxF = await signedInContext(browser, forastero)
  const pageF = await ctxF.newPage()
  await pageF.goto(`/invite/${token}`)
  await expect(pageF.getByTestId('pending')).toBeVisible()
  expect(await noHorizontalScroll(pageF), 'la espera de aprobación desborda a 390 px').toBe(true)

  // Y sin sesión, que es como llega quien recibe el link por primera vez.
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const pageA = await anon.newPage()
  await pageA.goto(`/invite/${token}`)
  await expect(pageA.getByTestId('invite-login')).toBeVisible()
  expect(await noHorizontalScroll(pageA), 'la invitación sin sesión desborda a 390 px').toBe(true)

  await ctxF.close(); await anon.close()
})

test('los controles de acción miden al menos 44 px', async ({ browser }) => {
  const owner = await createUser('mob-owner2')
  const { groupId, client } = await makeGroup(owner)
  await client.from('items').insert({ group_id: groupId, name: 'pan', created_by: owner.id })

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.goto(`/g/${groupId}`)

  for (const id of ['add-item', 'delete-item', 'create-invite']) {
    const box = await page.getByTestId(id).first().boundingBox()
    expect(box, `${id} no está en pantalla`).not.toBeNull()
    expect(box!.height, `${id} mide ${box!.height}px de alto`).toBeGreaterThanOrEqual(44)
  }
  await ctx.close()
})
