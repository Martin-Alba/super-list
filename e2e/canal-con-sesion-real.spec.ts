import { test, expect } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador } from './pkce'

/**
 * T3 / DoD 36 — De toda la rama del presupuesto de cabecera queda esto: que con
 * una sesión **real** el canal quede en vivo.
 *
 * Lo demás —constantes, bisección del techo, sembrado sintético, peor caso—
 * se retiró: perseguía un límite que sólo existía porque en local la app y
 * Supabase compartían host. Con los hosts separados (T1) el navegador no manda
 * ni una cookie de la app al endpoint de realtime, que es la topología de
 * producción. El número dejó de importar; el producto es lo que se prueba.
 */
test('DoD 36: con una sesión real, el canal queda en vivo', async ({ browser }) => {
  const tarro = nuevoTarro()
  const flujo = await nuevoFlujoPkce('rt-real', tarro)

  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  const page = await ctx.newPage()
  await page.goto(flujo.callbackUrl)
  await expect(page.getByTestId('create-group')).toBeVisible()

  await page.getByTestId('group-name').fill('Sesión real')
  await page.getByTestId('create-group').click()
  await expect(page.getByTestId('item-name')).toBeVisible()

  await expect(page.getByTestId('channel-live'), 'el canal no llegó a estar en vivo')
    .toHaveCount(1, { timeout: 20_000 })
  await ctx.close()
})
