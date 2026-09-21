import { test, expect, type Browser } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador } from './pkce'
import { COPIADO, COPIAR_FALLO } from '../lib/errors'

/**
 * Spec J / i8 — **El enlace de invitación, en la capa que j15 nombra.**
 *
 * j15 decía «el campo grande ya no está» y no tenía **ninguna** afirmación en el navegador:
 * `grep` sobre `e2e/` no devolvía `invite-link`, `share-invite`, `copy-invite` ni
 * `invite-text`. Reponer el campo de sólo lectura dejaba la suite entera verde, así que la
 * mitad del requisito que mira la pantalla no la miraba nadie.
 *
 * **Y aquí se ejercita el camino de copiar, no el de compartir**: `navigator.share` no existe
 * en el Chromium de Playwright, medido. Es fiel al mecanismo —`canShare ?? !!share` decide en
 * el cliente— y es además el camino que recorre cualquiera desde un escritorio. El de
 * compartir vive en `unit/invitar.test.tsx`, donde el doble sí puede existir, y eso queda
 * dicho en vez de fingido.
 */

async function entrar(browser: Browser, etiqueta: string) {
  const tarro = nuevoTarro()
  const flujo = await nuevoFlujoPkce(etiqueta, tarro)
  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  const page = await ctx.newPage()
  await page.goto(flujo.callbackUrl)
  await page.waitForLoadState('networkidle')
  return { ctx, page }
}

test('i8: el campo de sólo lectura no está, y el enlace se copia', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'inv1')
  await page.goto('/')
  await page.getByTestId('group-name').fill('Invitar')
  await page.getByTestId('create-group').click()
  await page.waitForURL(/\/g\//)

  // Antes de generar nada: el campo grande no existe en ningún estado de esta pantalla.
  await expect(page.getByTestId('invite-link')).toHaveCount(0)

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByTestId('create-invite').click()

  /**
   * El navegador de verdad decide, y lo que decide se comprueba en vez de suponerse: si algún
   * día este Chromium trae `navigator.share`, esta prueba lo dice en voz alta en lugar de
   * fallar por un `toBeVisible` sobre un botón que ya no se pinta.
   */
  const hayCompartir = await page.evaluate(() =>
    navigator.canShare?.({ url: 'https://x.test/a' }) ?? !!navigator.share)
  expect(hayCompartir, 'este navegador ahora comparte: esta prueba mide el otro camino').toBe(false)

  await expect(page.getByTestId('copy-invite')).toBeVisible()
  await expect(page.getByTestId('share-invite')).toHaveCount(0)
  await expect(page.getByTestId('invite-link'), 'volvió el campo que J-R6 quita').toHaveCount(0)
  // Y el enlace no se pinta mientras no haga falta: la decisión 3 dice «sólo cuando lo hay».
  await expect(page.getByTestId('invite-text')).toHaveCount(0)

  await page.getByTestId('copy-invite').click()
  await expect(page.getByTestId('notice')).toHaveText(COPIADO)
  /**
   * i4-R1 — **Y no se anuncia como un fallo.** Nació con origen `'mutacion'`, así que se
   * pintaba rojo con `role="alert"`: a quien usa lector de pantalla se le anunciaba de forma
   * asertiva, como un error, el único mensaje de éxito que tiene esta vista.
   *
   * Se afirma **aquí** y no sólo en jsdom porque es lo que ve una persona, y porque el camino
   * de éxito del portapapeles no se puede recorrer a mano: sin `grantPermissions` el navegador
   * lo deniega, y concederlo a mano es tocar un ajuste del navegador. Ésta es la única capa
   * donde ese camino se recorre de verdad.
   */
  await expect(page.getByTestId('notice')).toHaveAttribute('role', 'status')
  await expect(page.getByTestId('notice'), 'el acuse de copiado se pinta como un error')
    .not.toHaveClass(/red/)
  const copiado = await page.evaluate(() => navigator.clipboard.readText())
  expect(copiado, 'el aviso dijo que copió y el portapapeles no lo tiene')
    .toMatch(/\/invite\/[0-9a-f]{48}$/)
  await ctx.close()
})

test('i8: sin permiso de portapapeles, el enlace sale a la vista', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'inv2')
  await page.goto('/')
  await page.getByTestId('group-name').fill('Invitar sin permiso')
  await page.getByTestId('create-group').click()
  await page.waitForURL(/\/g\//)

  // Sin `grantPermissions`: escribir en el portapapeles se rechaza, y ése es el callejón.
  await page.getByTestId('create-invite').click()
  await page.getByTestId('copy-invite').click()

  await expect(page.getByTestId('notice')).toHaveText(COPIAR_FALLO)
  const texto = page.getByTestId('invite-text')
  await expect(texto, 'copiar falló y no quedó ninguna forma de conseguir el enlace').toBeVisible()
  await expect(texto).toHaveText(/\/invite\/[0-9a-f]{48}$/)
  // Es texto, no el campo de vuelta.
  expect(await texto.evaluate(e => e.tagName)).not.toBe('INPUT')
  await ctx.close()
})
