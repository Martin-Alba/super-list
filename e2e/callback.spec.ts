import { test, expect } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador, CLAVE_COOKIE } from './pkce'
import { appOrigin, appHostname, appPort } from './appOrigin'
import { hostDelDestino } from './destino'

/** W4 — derivado, no fijado: mover `E2E_BASE_URL` debe moverlo todo. */
const hostDeLaApp = () => new URL(appOrigin()).host

/**
 * M5 / DoD 1, 2, 3, 5 — los 19 E2E anteriores nunca tocaron esta ruta: sembraban
 * la sesión directamente en el contexto del navegador. El fallo vivía justo en
 * el tramo que se saltaban. Aquí se le hace una petición HTTP real y se mira la
 * cabecera `Location` que emite, que es donde estaba el defecto.
 *
 * Capa (§E.1): la ruta. No se prueba una función auxiliar: se prueba lo que el
 * servidor responde.
 */
/**
 * U13 — Esto listaba dos direcciones de conexión: `localhost:3000` y
 * `127.0.0.1:3000`. Al separar los hosts (T1) el servidor dejó de escuchar en la
 * segunda **a propósito**, y el test se puso rojo por la razón contraria a la
 * que vigila: no es que el callback salte de host, es que ese host ya no existe.
 *
 * Se parametriza por la cabecera `Host`, que es la capa donde vivía el fallo 1:
 * el servidor construía el destino desde el origen que él resuelve, no desde el
 * host que pidió el cliente. Variar la cabecera reproduce exactamente esa
 * discrepancia contra el único puerto que sí sirve.
 */
const HOSTS = [hostDeLaApp(), '127.0.0.1:3000', 'super.example:3000']

/**
 * Petición cruda: `APIRequestContext` no deja falsear `Host`, y falsearlo es
 * justo lo que hay que hacer para reproducir el fallo. Se habla con el único
 * puerto que sirve y se anuncia otro nombre, como haría un proxy delante.
 */
async function pedir(ruta: string, host: string) {
  const { request: peticion } = await import('node:http')
  return new Promise<{ status: () => number; headers: () => Record<string, string> }>((ok, mal) => {
    const req = peticion(
      { host: appHostname(), port: appPort(), path: ruta, headers: { Host: host } },
      res => {
        res.resume()
        ok({ status: () => res.statusCode!, headers: () => res.headers as Record<string, string> })
      },
    )
    req.on('error', mal)
    req.end()
  })
}


test.describe('M1 el callback devuelve al mismo host desde el que se pidió', () => {
  // DoD 1 y 3 — medido antes del cambio: pedido por 127.0.0.1 respondía
  // `${appOrigin()}/…`, y la cookie de sesión quedaba en el otro origen.
  for (const host of HOSTS) {
    test(`sin código, pedido por ${host}, no salta de host`, async () => {
      const res = await pedir(`/auth/callback?next=%2F`, host)
      expect(res.status()).toBeGreaterThanOrEqual(300)
      expect(res.status()).toBeLessThan(400)

      const location = res.headers()['location'] ?? null
      const destino = hostDelDestino(location)
      expect(destino, `saltó a ${destino} desde ${host} (Location: ${location})`)
        .toBe(null)
      expect(location).toContain('/login')
    })

    test(`con código inválido, pedido por ${host}, no salta de host`, async () => {
      const res = await pedir(`/auth/callback?code=no-vale&next=%2F`, host)
      const location = res.headers()['location'] ?? null
      expect(hostDelDestino(location), `Location: ${location}`).toBe(null)
      expect(location).toContain('/login')
    })
  }

  // DoD 4 / borde 4 — el destino relativo no puede reabrir lo que safeNext cerró.
  test('un next hostil sigue neutralizado con el Location relativo', async ({ request }) => {
    for (const hostil of ['//example.com/', '/%5Cexample.com', 'https://example.com']) {
      const res = await request.get(
        `${appOrigin()}/auth/callback?next=${encodeURIComponent(hostil)}`, { maxRedirects: 0 })
      const location = res.headers()['location'] ?? ''
      expect(hostDelDestino(location), `${hostil} produjo ${location}`).toBe(null)
      expect(location.startsWith('//'), `${hostil} produjo ${location}`).toBe(false)
    }
  })
})

/**
 * DoD 9, 10 y 16 — la salida de ÉXITO, que es donde el destino validado llega
 * de verdad a la cabecera y donde se escribe la sesión. Sin recorrerla, el test
 * del `next` hostil pasaba con `safeNext` borrado, y una regresión que devolvía
 * 500 y quemaba el código pasó inadvertida.
 */
test.describe('la salida de éxito del callback', () => {
  test('DoD 9: un next no-ASCII produce un redirect, no un 500, y trae sesión', async ({ browser }) => {
    const tarro = nuevoTarro()
    const flujo = await nuevoFlujoPkce('no-ascii', tarro)
    const ctx = await browser.newContext()
    await ctx.addCookies(paraNavegador(tarro))

    // U+2044 (barra de fracción): pasa `safeNext` y rompía la cabecera cruda.
    const destino = '/\u2044\u2044evil.com'
    const res = await ctx.request.get(
      `${appOrigin()}/auth/callback?code=${flujo.code}&next=${encodeURIComponent(destino)}`,
      { maxRedirects: 0 })

    expect(res.status(), 'la ruta reventó en vez de redirigir').toBeLessThan(400)
    const location = res.headers()['location']
    expect(location, 'no emitió Location').toBeTruthy()
    expect(hostDelDestino(location), `salió del sitio: ${location}`).toBe(null)
    // P5 / DoD 21 — sin esto, las tres afirmaciones anteriores las satisface
    // cualquier intercambio FALLIDO: el test podía pasar en vacío.
    const setCookie = res.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie')
    expect(setCookie.some(h => h.value.includes('sb-127-auth-token')),
      'no se emitió cookie de sesión: el intercambio no llegó a completarse').toBe(true)
    await ctx.close()
  })

  test('DoD 10: con código válido, un next hostil acaba dentro del sitio', async ({ browser }) => {
    const tarro = nuevoTarro()
    const flujo = await nuevoFlujoPkce('hostil', tarro)
    const ctx = await browser.newContext()
    await ctx.addCookies(paraNavegador(tarro))

    const res = await ctx.request.get(
      `${appOrigin()}/auth/callback?code=${flujo.code}&next=${encodeURIComponent('//example.com/')}`,
      { maxRedirects: 0 })

    const location = res.headers()['location'] ?? ''
    expect(hostDelDestino(location), `Location: ${location}`).toBe(null)
    expect(location.startsWith('//'), `Location: ${location}`).toBe(false)
    expect(location).toBe('/')
    await ctx.close()
  })

  test('DoD 16: tras navegar, el host final es el de la petición', async ({ browser }) => {
    const tarro = nuevoTarro()
    const flujo = await nuevoFlujoPkce('host', tarro)
    const ctx = await browser.newContext()
    await ctx.addCookies(paraNavegador(tarro))
    const page = await ctx.newPage()

    await page.goto(`${appOrigin()}/auth/callback?code=${flujo.code}&next=%2F`)
    expect(new URL(page.url()).host, 'saltó de host').toBe(hostDeLaApp())
    // Y la sesión quedó del lado correcto: se ve la pantalla de dentro.
    await expect(page.getByTestId('create-group')).toBeVisible()
    await ctx.close()
  })
})

/**
 * DoD 13 (N5) — este test afirmaba que el callback BARRÍA los verificadores.
 * La premisa era falsa: las tres cookies son la huella de **un** flujo
 * pendiente, no tres huérfanas, y el barrido ciego rompía logins en vuelo.
 * Ahora afirma lo contrario, que es lo correcto: un GET sin `code` no destruye
 * el estado de nadie, y un intercambio completado no deja verificadores atrás.
 */
test('DoD 13: un GET sin código no destruye flujos ajenos en vuelo', async ({ browser }) => {
  const ctx = await browser.newContext()
  const enVuelo = [
    { name: 'sb-127-auth-token-code-verifier', value: 'a'.repeat(120), domain: appHostname(), path: '/' },
    { name: 'sb-127-auth-token-flow-fe37a0fc77035c312728c7bfbf806127-code-verifier', value: 'b'.repeat(200), domain: appHostname(), path: '/' },
    { name: 'sb-127-auth-token-flows-code-verifier', value: 'c'.repeat(100), domain: appHostname(), path: '/' },
  ]
  await ctx.addCookies(enVuelo)

  const page = await ctx.newPage()
  // Es lo que provoca otra pestaña, un doble clic o un enlace externo.
  await page.goto(`${appOrigin()}/auth/callback`)
  await page.goto(`${appOrigin()}/auth/callback?code=no-vale`)

  const quedan = (await ctx.cookies()).filter(c => c.name.endsWith('-code-verifier')).map(c => c.name)
  expect(quedan.sort(), 'el callback destruyó el estado de un login en vuelo')
    .toEqual(enVuelo.map(c => c.name).sort())
  await ctx.close()
})

/**
 * DoD 13, segunda mitad — reescrito por P1. Se escribió bajo el diseño de N5
 * (barrer TODOS los verificadores tras el éxito), que P1 sustituyó: con el
 * identificador de flujo, `auth-js` consume **su** slot y deja los ajenos en
 * pie. Exigir cero era exigir el comportamiento destructivo que P1 retiró.
 */
test('DoD 13: un intercambio completado consume SU verificador', async ({ browser }) => {
  const tarro = nuevoTarro()
  const flujo = await nuevoFlujoPkce('limpieza', tarro)
  expect(flujo.flowId, 'no viajó identificador de flujo').toBeTruthy()
  const suSlot = `sb-127-auth-token-flow-${flujo.flowId}-code-verifier`

  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  expect((await ctx.cookies()).map(c => c.name), 'el fixture no sembró el slot esperado')
    .toContain(suSlot)

  const page = await ctx.newPage()
  await page.goto(flujo.callbackUrl)
  await expect(page.getByTestId('create-group')).toBeVisible()

  // Q4 — vuelve el "cero verificadores", ACOTADO al caso donde de verdad
  // aplica: un único flujo pendiente. Bajarlo a "su slot" dejaba el índice y la
  // clave fija —284 B por login— sin ninguna guarda, que es la acumulación que
  // M3 existía para impedir.
  const restantes = (await ctx.cookies()).filter(c => c.name.endsWith('-code-verifier')).map(c => c.name)
  expect(restantes, 'su propio verificador sobrevivió al canje').not.toContain(suSlot)
  expect(restantes, 'con un único flujo pendiente no debe sobrevivir ningún verificador').toEqual([])
  await ctx.close()
})

/**
 * P1 / DoD 17 y 18 — dos flujos concurrentes, que es lo que produce abrir dos
 * pestañas o pulsar dos veces "Entrar con Google". Medido antes del cambio: la
 * pestaña que volvía primero recibía `/login?error=auth` con su código quemado,
 * porque sin identificador de flujo el verificador que se leía era el del
 * inicio más reciente.
 */
/**
 * DoD 17, primera mitad — la del CLIENTE. El test de abajo prueba que la ruta
 * consume bien el `flowId`, pero no que la app lo haga viajar: el ayudante PKCE
 * pone la bandera en su propio cliente, así que el identificador aparecía
 * aunque la app no lo emitiera. Control negativo comprobado: con la bandera
 * apagada, el test de abajo seguía verde. Éste no.
 *
 * Se mira a dónde intenta ir el botón de login, sin llegar a Google.
 */
test('DoD 17: el botón de login hace viajar el identificador de flujo', async ({ page }) => {
  let destino: string | null = null
  await page.route('**/auth/v1/authorize*', route => {
    destino = route.request().url()
    return route.abort()
  })

  await page.goto('/login')
  await page.getByTestId('google-signin').click()
  await expect.poll(() => destino, { timeout: 10_000 }).not.toBeNull()

  const redirectTo = new URL(destino!).searchParams.get('redirect_to') ?? ''
  expect(redirectTo, `la app no pidió volver a su callback: ${destino}`).toContain('/auth/callback')
  const flowId = new URL(redirectTo).searchParams.get('sb_flow_id')
  expect(flowId, 'el callback no lleva identificador de flujo: dos logins simultáneos se pisarán')
    .toBeTruthy()

  // Q7 — la composición de las dos mitades. Ocho tests dan por supuesta la
  // clave de almacenamiento y ninguno afirma que el identificador anunciado
  // apunte al slot que el navegador acaba de escribir.
  const nombres = (await page.context().cookies()).map(c => c.name)
  expect(nombres, `el id anunciado (${flowId}) no direcciona ninguna cookie escrita`)
    .toContain(`${CLAVE_COOKIE}-flow-${flowId}-code-verifier`)
})

/**
 * Q1 / DoD 23 — La puerta que ABRIÓ P1 (regla R-C). Antes, sin identificador de
 * flujo, el adaptador de servidor no volcaba la eliminación del verificador;
 * ahora un canje fallido que traiga un `sb_flow_id` ajeno sí lo borra. El test
 * que ya existía cubre el caso sin `code`, que es el que P1 volvió inofensivo.
 *
 * Queda fijado el comportamiento, no disimulado. **La cota que declaré antes era
 * falsa** y está corregida en la deuda técnica: el identificador se genera con
 * un CSPRNG (`crypto.getRandomValues`), pero **sí viaja** — en `redirect_to` hasta el
 * servidor de auth, dentro del `state` que recibe Google, y en la URL de
 * `/auth/callback` que queda en los registros de la app.
 */
test('DoD 23: un canje fallido con un sb_flow_id ajeno — comportamiento fijado', async ({ browser }) => {
  const tarro = nuevoTarro()
  const victima = await nuevoFlujoPkce('victima', tarro)
  const suSlot = `${CLAVE_COOKIE}-flow-${victima.flowId}-code-verifier`

  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  expect((await ctx.cookies()).map(c => c.name)).toContain(suSlot)

  await ctx.request.get(
    `${appOrigin()}/auth/callback?code=basura&sb_flow_id=${victima.flowId}`,
    { maxRedirects: 0 })

  const sobrevive = (await ctx.cookies()).map(c => c.name).includes(suSlot)
  // Se AFIRMA lo que ocurre, para que un cambio de comportamiento se vea. Si
  // algún día `auth-js` deja de volcar la eliminación en el fallo, este test lo
  // dirá en vez de pasar en silencio.
  expect(sobrevive, 'el verificador de la víctima sobrevivió: el comportamiento cambió respecto a lo medido')
    .toBe(false)
  await ctx.close()
})

test('DoD 17: dos flujos PKCE en paralelo terminan AMBOS con sesión', async ({ browser }) => {
  const tarro = nuevoTarro()
  const primero = await nuevoFlujoPkce('par-a', tarro)
  const segundo = await nuevoFlujoPkce('par-b', tarro)
  expect(primero.flowId, 'no viajó identificador de flujo').toBeTruthy()
  expect(segundo.flowId).toBeTruthy()
  expect(segundo.flowId).not.toBe(primero.flowId)

  const conSesion = async (url: string) => {
    const ctx = await browser.newContext()
    await ctx.addCookies(paraNavegador(tarro))
    const res = await ctx.request.get(url, { maxRedirects: 0 })
    const location = res.headers()['location'] ?? ''
    const emiteSesion = res.headersArray()
      .some(h => h.name.toLowerCase() === 'set-cookie' && h.value.includes('sb-127-auth-token'))
    await ctx.close()
    return { location, emiteSesion }
  }

  // El orden importa: el que vuelve PRIMERO es el que se rompía.
  const a = await conSesion(primero.callbackUrl)
  const b = await conSesion(segundo.callbackUrl)

  expect(a.emiteSesion, `el primer flujo se quedó sin sesión (Location: ${a.location})`).toBe(true)
  expect(b.emiteSesion, `el segundo flujo se quedó sin sesión (Location: ${b.location})`).toBe(true)
  expect(a.location).toBe('/')
  expect(b.location).toBe('/')
})

test('DoD 18: un intercambio exitoso no toca el verificador de otro flujo', async ({ browser }) => {
  const tarro = nuevoTarro()
  const usado = await nuevoFlujoPkce('vivo-a', tarro)
  await nuevoFlujoPkce('vivo-b', tarro)

  const ctx = await browser.newContext()
  await ctx.addCookies(paraNavegador(tarro))
  const antes = (await ctx.cookies()).filter(c => c.name.endsWith('-code-verifier')).length

  const page = await ctx.newPage()
  await page.goto(usado.callbackUrl)
  await expect(page.getByTestId('create-group')).toBeVisible()

  const despues = (await ctx.cookies()).filter(c => c.name.endsWith('-code-verifier')).length
  expect(despues, 'el intercambio arrasó con los verificadores de los demás flujos')
    .toBeGreaterThan(0)
  expect(despues, 'no se limpió ningún verificador: el suyo debería haberse consumido')
    .toBeLessThan(antes)
  await ctx.close()
})
