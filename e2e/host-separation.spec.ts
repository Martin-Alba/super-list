import { test, expect } from '@playwright/test'
import { appOrigin, appHostname, appPort } from './appOrigin'
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
 * U13 — La separación de hosts sólo se sostiene si la app NO atiende también en
 * el host de Supabase. Servía en ambos, y así es como las cookies volvieron a
 * cruzarse: el navegador las acota por host, no por puerto.
 */
async function atiende(host: string, puerto: number): Promise<boolean> {
  const { request: peticion } = await import('node:http')
  return new Promise<boolean>(ok => {
    const req = peticion({ host, port: puerto, path: '/', timeout: 3_000 }, res => { res.resume(); ok(true) })
    req.on('error', () => ok(false))
    req.on('timeout', () => { req.destroy(); ok(false) })
    req.end()
  })
}

test('DoD 44: la app no atiende en el host de Supabase', async () => {
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!)
  expect(await atiende(supabase.hostname, appPort()),
    `la app atiende en ${supabase.hostname}:${appPort()}: los hosts volvieron a juntarse`).toBe(false)
})

/**
 * V7 / DoD 53 — Sonda (§E.2). Sin ella, `atiende()` devolviendo siempre `false`
 * —una opción mal puesta, un `host` que no resuelve— dejaría la guarda de arriba
 * verde para siempre. Se exige que el MISMO helper sí alcance la app.
 */
test('DoD 53: el helper de alcance sí ve el host donde la app atiende', async () => {
  expect(await atiende(appHostname(), appPort()),
    `el instrumento no alcanza ${appOrigin()}, donde la app sí atiende: no mide nada`).toBe(true)
})
