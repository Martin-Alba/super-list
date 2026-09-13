import { test, expect } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador } from './pkce'

/**
 * T4 / DoD 35 — La garantía NUEVA, y por R-C la puerta que este cambio abre: si
 * alguien vuelve a servir la app en el mismo host que Supabase, las cookies
 * vuelven a viajar al endpoint de realtime y la cabecera vuelve a desbordar.
 *
 * Es lo que hace innecesaria toda la rama del presupuesto: no se afina un
 * límite, se deja de mandar lo que lo desbordaba.
 */
test('DoD 35: el navegador no manda cookies de la app al endpoint de Supabase', async ({ browser }) => {
  const tarro = nuevoTarro()
  const flujo = await nuevoFlujoPkce('sep', tarro)

  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  const page = await ctx.newPage()
  await page.goto(flujo.callbackUrl)
  await expect(page.getByTestId('create-group')).toBeVisible()

  // Hay sesión: si los hosts coincidieran, estas cookies irían en cada petición
  // al endpoint de realtime.
  const propias = (await ctx.cookies()).filter(c => c.name.startsWith('sb-'))
  expect(propias.length, 'no hay sesión: el test no está midiendo nada').toBeGreaterThan(0)

  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!)
  expect(new URL(page.url()).hostname, 'la app se está sirviendo en el host de Supabase')
    .not.toBe(supabase.hostname)

  // Lo que de verdad decide qué manda un WebSocket es el almacén de cookies del
  // navegador para el host de destino. Se consulta directamente: un `fetch`
  // cross-origin no sirve de medida —CORS lo rechaza antes— y mediría otra cosa.
  const paraSupabase = await ctx.cookies(supabase.origin)
  expect(paraSupabase.map(c => c.name), 'las cookies de la app viajan a Supabase: los hosts se juntaron')
    .toEqual([])

  // U9 — hostnames distintos NO bastan si una cookie lleva `Domain` de un padre
  // común, que es el caso de producción con dominio propio de Supabase.
  expect(conDominioPadre(propias).map(c => c.name), 'una cookie de la app lleva Domain padre: cruzaría igual')
    .toEqual([])
  await ctx.close()
})

/**
 * Sonda (§E.2) — sin esto, el test de arriba no distingue "no viajan cookies" de
 * "no estoy mirando". Se acota una cookie AL host de Supabase y se exige verla.
 */
test('DoD 43: la guarda ve una cookie que sí está acotada al host de Supabase', async ({ browser }) => {
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!)
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name: 'sonda-separacion', value: 'x', domain: supabase.hostname, path: '/' }])

  const vistas = await ctx.cookies(supabase.origin)
  expect(vistas.map(c => c.name), 'el instrumento no ve una cookie del host de Supabase')
    .toContain('sonda-separacion')
  await ctx.close()
})

/**
 * W6 — La guarda y su sonda compartían la idea pero no el código: la sonda
 * reimplementaba `c.domain.startsWith('.')`, así que cambiar la guarda la dejaba
 * verde. Vigilaba una copia, no la guarda. Ahora las dos llaman aquí.
 */
export const conDominioPadre = <T extends { domain: string }>(cookies: T[]) =>
  cookies.filter(c => c.domain.startsWith('.'))

/**
 * V7 / DoD 53 — Sonda (§E.2) del filtro de `Domain`. La aserción de arriba
 * (`domain.startsWith('.')`) no demostraba nada: una cookie con dominio padre
 * nunca se le puso delante, así que "ninguna la lleva" no se distinguía de "el
 * filtro no caza ninguna". Es el mismo defecto que U9 vino a arreglar en la
 * guarda hermana, reintroducido al lado.
 */
test('DoD 53: el filtro de Domain caza una cookie de dominio padre', async ({ browser }) => {
  const ctx = await browser.newContext()
  // Un dominio padre real: `localhost` no admite `Domain`, así que se usa uno
  // con puntos, que es la forma que tomaría en producción.
  await ctx.addCookies([{ name: 'sb-sonda-dominio', value: 'x', domain: '.super.example', path: '/' }])

  const propias = (await ctx.cookies()).filter(c => c.name.startsWith('sb-'))
  expect(propias.length, 'la sonda no llegó a existir').toBeGreaterThan(0)

  expect(conDominioPadre(propias).map(c => c.name), 'el filtro de Domain no caza una cookie de dominio padre')
    .toContain('sb-sonda-dominio')
  await ctx.close()
})

/**
 * U13 / deuda 51 — Aquí vivían `DoD 44` («la app no atiende en el host de
 * Supabase») y su sonda `DoD 53`. **Se retiraron el 2026-09-13 porque no podían
 * pasar.** El arnés arranca `next start --hostname localhost`, y en macOS
 * `localhost` liga `127.0.0.1`, que es exactamente el host de Supabase: la
 * aserción era imposible por construcción. Nació roja el 2026-09-07, y el
 * registro la declaró verde tres veces antes de que nadie la mirara.
 *
 * El fondo: pedían separación a nivel de **TCP** para proteger una propiedad del
 * **tarro de cookies del navegador**, que es otra capa (§E.1). La propiedad real
 * —que los dos hosts configurados sean distintos— la comprueba ahora
 * `unit/app-origin.test.ts`, con su sonda. Y el efecto en el navegador lo
 * comprueban los tres casos de cookies de este mismo fichero, que sí pasan.
 */
