import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador } from './pkce'
import { admin } from './fixtures'
import { PENDIENTE, RED, SERVIDOR, SIN_INSTANTANEA, SIN_RED, SIN_RED_ACCION,
  SIN_RED_FUERA, SIN_RED_CON_COPIA, SIN_RED_ESPERANDO } from '../lib/errors'
import { addActiveMember, createUser, makeGroup, signedInContext } from './fixtures'
import { appOrigin } from './appOrigin'

/**
 * La entrega entera se prueba **con la red cortada de verdad**
 * (`context.setOffline`), no simulando en jsdom: el requisito habla de un
 * supermercado sin cobertura, y esa es la capa donde existe.
 *
 * Ninguna sesión se siembra: se entra atravesando el callback con un código real.
 */
async function entrar(browser: Browser, etiqueta: string) {
  const ctx = await browser.newContext()
  const { page, id } = await entrarEn(ctx, etiqueta)
  return { ctx, page, id }
}

/** El mismo login, en un contexto que ya existe: dos personas, un dispositivo. */
async function entrarEn(ctx: BrowserContext, etiqueta: string) {
  const tarro = nuevoTarro()
  const flujo = await nuevoFlujoPkce(etiqueta, tarro)
  await ctx.addCookies(paraNavegador(tarro))
  const page = await ctx.newPage()
  await page.goto(flujo.callbackUrl)
  await page.waitForLoadState('networkidle')
  return { page, id: flujo.id }
}

/**
 * J2 — El service worker guardado **y con el shell dentro**. Esperar sólo a que
 * active no basta: el precacheado va en `waitUntil` y termina después, así que
 * cortar la red antes deja la clave del shell vacía y el arranque en frío da la
 * pantalla de error del navegador — que es justo lo que se está probando que no
 * pasa. Se espera a lo que se va a usar.
 */
async function shellGuardado(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(r => !!r.active),
    null, { timeout: 30_000 })
  await page.waitForFunction(() => caches.match('/sin-conexion').then(r => !!r),
    null, { timeout: 30_000 })
}

/** Lo que el shell lee para saber de quién es la instantánea que puede pintar. */
const ultimoUsuario = (page: Page) => page.evaluate(() => new Promise<string | null>((ok) => {
  const req = indexedDB.open('super', 1)
  req.onerror = () => ok(null)
  req.onsuccess = () => {
    try {
      const p = req.result.transaction('listas', 'readonly').objectStore('listas').get('ultimo-usuario')
      p.onsuccess = () => ok((p.result as string) ?? null)
      p.onerror = () => ok(null)
    } catch { ok(null) }
  }
}))

async function grupoCon(page: Page, nombre: string) {
  await page.goto('/')
  await page.getByTestId('group-name').fill(nombre)
  await page.getByTestId('create-group').click()
  await page.waitForURL(/\/g\//)
  return page.url().split('/g/')[1]
}

const apuntar = async (page: Page, nombre: string, cantidad = '') => {
  await page.getByTestId('item-name').fill(nombre)
  if (cantidad) await page.getByTestId('item-qty').fill(cantidad)
  await page.getByTestId('add-item').click()
}

/** R3 / DoD 5 y 6 — apuntar sin red, y que llegue al volver. */
test('DoD 5 y 6: sin red se apunta, y al volver la red llega a la base', async ({ browser }) => {
  const a = await entrar(browser, 'red1')
  const gid = await grupoCon(a.page, 'SinRed')
  await expect(a.page.getByTestId('channel-live')).toHaveCount(1)

  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await apuntar(a.page, 'lentejas', '2')

  // Se ve, marcado, y el campo queda libre para seguir apuntando.
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(1)
  await expect(a.page.getByTestId('item-pendiente')).toContainText('lentejas')
  await expect(a.page.getByTestId('item-pendiente')).toContainText(PENDIENTE)
  await expect(a.page.getByTestId('item-name')).toHaveValue('')

  // Nada ha llegado a la base todavía: es una cola, no un envío optimista.
  const antes = await admin.from('items').select('id', { count: 'exact', head: true })
    .eq('group_id', gid).is('deleted_at', null)
  expect(antes.count, 'se escribió en la base estando sin red').toBe(0)

  await a.ctx.setOffline(false)
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(0, { timeout: 20_000 })
  // El nombre de una fila vive en su campo, no en el texto del `li`.
  await expect(a.page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('lentejas')
  const despues = await admin.from('items').select('name').eq('group_id', gid).is('deleted_at', null)
  expect(despues.data?.map(x => x.name)).toEqual(['lentejas'])
  await a.ctx.close()
})

/**
 * I4 / DoD 23 y 24 — Lo que la revisión midió roto, determinista: seis altas
 * seguidas dejaban tres. El campo se vaciaba **después** del `await`, así que lo
 * tecleado entre medias se iba con él.
 */
test('DoD 23 y 24: seis altas seguidas sin red entran las seis, sin duplicar', async ({ browser }) => {
  const a = await entrar(browser, 'red12')
  const gid = await grupoCon(a.page, 'Seis')
  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })

  const seis = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']
  for (const n of seis) await apuntar(a.page, n)
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(6)
  const vistos = await a.page.getByTestId('item-pendiente').allInnerTexts()
  for (const n of seis) {
    expect(vistos.join(' '), `se perdió "${n}" al apuntar seguido`).toContain(n)
  }

  // Y dos toques sobre el mismo producto no crean dos fichas.
  await a.page.getByTestId('item-name').fill('doblete')
  await a.page.getByTestId('add-item').click()
  await a.page.getByTestId('add-item').click()
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(7)
  await a.ctx.close()
  expect(gid).toBeTruthy()
})

/** R5 / DoD 8 — la cola sobrevive a cerrar la pestaña. */
test('DoD 8: lo apuntado sin red sobrevive a cerrar la app', async ({ browser }) => {
  const a = await entrar(browser, 'red2')
  const gid = await grupoCon(a.page, 'Sobrevive')
  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await apuntar(a.page, 'garbanzos')
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(1)

  // Se cierra la pestaña con la cola pendiente y se vuelve, ya con red.
  await a.page.close()
  const otra = await a.ctx.newPage()
  await a.ctx.setOffline(false)
  await otra.goto(`/g/${gid}`)
  await expect(otra.getByTestId('item').first().getByLabel('Nombre'))
    .toHaveValue('garbanzos', { timeout: 20_000 })
  await a.ctx.close()
})

/** R6 / DoD 10 — sin red se ve la lista ya abierta. */
test('DoD 10: sin red, la lista del grupo ya abierto sigue ahí', async ({ browser }) => {
  const a = await entrar(browser, 'red3')
  const gid = await grupoCon(a.page, 'Instantanea')
  await apuntar(a.page, 'aceite')
  await expect(a.page.getByTestId('item')).toHaveCount(1)

  /**
   * Se navega al documento **con red** antes de cortarla: es lo que le da al
   * service worker la ocasión de guardarlo. Llegar aquí por transición de cliente
   * —como hace `grupoCon`— no pide ningún documento, así que no hay nada que
   * cachear, y sin esa vuelta el arranque en frío sin red no puede funcionar.
   */
  await a.page.goto(`/g/${gid}`)
  await expect(a.page.getByTestId('item')).toHaveCount(1)

  await a.ctx.setOffline(true)
  await a.page.reload().catch(() => { /* sin red, el documento lo sirve el shell */ })
  /**
   * Recargar es una navegación, así que lo que responde es el shell estático — no
   * el documento de antes, que llevaría los datos de este usuario a un disco
   * compartido. La lista sigue ahí, en sólo lectura, desde la instantánea local.
   */
  await expect(a.page.getByTestId('item').first())
    .toContainText('aceite', { timeout: 20_000 })
  await expect(a.page.getByTestId('sin-red')).toContainText(SIN_RED_CON_COPIA)
  await a.ctx.close()
})

/** R7 / DoD 12 — sin red, editar y borrar quedan bloqueados y lo dicen. */
test('DoD 12: sin red no se edita ni se borra, y se explica', async ({ browser }) => {
  const a = await entrar(browser, 'red4')
  await grupoCon(a.page, 'Bloqueado')
  await apuntar(a.page, 'pan')
  await expect(a.page.getByTestId('item')).toHaveCount(1)

  await a.ctx.setOffline(true)
  // Se espera a que la app lo diga. Actuar antes es una carrera contra el evento
  // del navegador: medido, fallaba 1 de cada 3.
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await a.page.getByTestId('delete-item').click()
  await expect(a.page.getByTestId('notice')).toContainText(SIN_RED_ACCION)
  await expect(a.page.getByTestId('item'), 'la fila desapareció sin haberse borrado').toHaveCount(1)

  await a.page.getByLabel('Cantidad de pan').fill('3')
  await a.page.getByLabel('Cantidad de pan').blur()
  await expect(a.page.getByTestId('notice')).toContainText(SIN_RED_ACCION)
  await a.ctx.close()
})

/** R1 / DoD 1 — sin red se culpa a la red; con red, al servidor. */
test('DoD 1 y 2: el aviso distingue tu red del servidor de datos', async ({ browser }) => {
  const a = await entrar(browser, 'red5')
  await grupoCon(a.page, 'Estados')
  // Una fila de verdad, con red, para tener sobre qué actuar después.
  await apuntar(a.page, 'sal')
  await expect(a.page.getByTestId('item')).toHaveCount(1)

  // (a) La base no contesta, pero la red del usuario está bien.
  await a.page.route(/\/rest\/v1\/items/, r => r.abort('connectionfailed'))
  await apuntar(a.page, 'pimienta')
  await expect(a.page.getByTestId('notice')).toContainText(SERVIDOR)
  await expect(a.page.getByTestId('notice'), 'culpó a la conexión del usuario')
    .not.toContainText(RED)

  // (b) La red del usuario, caída de verdad: entonces sí es suya, y lo que se
  // bloquea es corregir, no apuntar.
  await a.page.unroute(/\/rest\/v1\/items/)
  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await expect(a.page.getByTestId('sin-red')).toContainText(SIN_RED)
  await a.page.getByTestId('delete-item').first().click()
  await expect(a.page.getByTestId('notice')).toContainText(SIN_RED_ACCION)
  await a.ctx.close()
})

/** R2 / DoD 3 — el servicio despierta y la app se recupera sola. */
test('DoD 3: cuando el servidor vuelve, la app se recupera sin que nadie pulse', async ({ browser }) => {
  const a = await entrar(browser, 'red6')
  const gid = await grupoCon(a.page, 'Despierta')

  let dormido = true
  await a.page.route(/\/rest\/v1\/items/, r => (dormido ? r.abort('connectionfailed') : r.continue()))
  await apuntar(a.page, 'arroz')
  await expect(a.page.getByTestId('notice')).toContainText(SERVIDOR)

  // Alguien más añade algo mientras el servicio estaba dormido para esta pestaña.
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'azucar', created_by: dueno.user_id })
  dormido = false

  // Nadie pulsa nada: el reintento acotado trae la lista y retira el aviso.
  await expect(a.page.getByTestId('item').first().getByLabel('Nombre'))
    .toHaveValue('azucar', { timeout: 30_000 })
  await expect(a.page.getByTestId('notice')).toHaveCount(0)
  await a.ctx.close()
})

/** R8 / DoD 13 — el manifiesto se sirve y no pasa por el proxy. */
test('DoD 13: el manifiesto es instalable y el proxy no lo toca', async ({ page }) => {
  const res = await page.goto('/manifest.webmanifest')
  expect(res?.status()).toBe(200)
  const m = await res!.json()
  expect(m.display).toBe('standalone')
  expect(m.start_url).toBe('/')
  const tamanos = (m.icons ?? []).map((i: { sizes: string }) => i.sizes)
  expect(tamanos, 'faltan los tamaños que exige la instalación').toEqual(
    expect.arrayContaining(['192x192', '512x512']))
  for (const icono of m.icons) {
    const r = await page.request.get(icono.src)
    expect(r.status(), `${icono.src} no se sirve`).toBe(200)
  }
})

/** Lee la cola del navegador tal cual está en el disco del dispositivo. */
const listasEn = (page: Page) => page.evaluate(() => new Promise<unknown[]>((resolve) => {
  const req = indexedDB.open('super', 1)
  req.onsuccess = () => {
    const t = req.result.transaction('listas', 'readonly').objectStore('listas').getAllKeys()
    t.onsuccess = () => resolve(t.result.filter(k => typeof k === 'string' && k.includes(':')))
    t.onerror = () => resolve([])
  }
  req.onerror = () => resolve([])
}))

const colaEn = (page: Page) => page.evaluate(() => new Promise<unknown[]>((resolve) => {
  const req = indexedDB.open('super', 1)
  req.onsuccess = () => {
    const t = req.result.transaction('cola', 'readonly').objectStore('cola').getAll()
    t.onsuccess = () => resolve(t.result)
    t.onerror = () => resolve([])
  }
  req.onerror = () => resolve([])
}))

/**
 * R5 / DoD 9 — Lo que lleva más de un día se descarta al abrir, y se dice cuánto.
 *
 * **Siembra declarada:** la entrada vieja se escribe directamente en el almacén,
 * así que **no se ejecuta el camino que la crea** —ése lo cubre DoD 5— y no se
 * espera un día real. La única diferencia medible entre la sembrada y una real es
 * la marca de tiempo, que es justo lo que este ítem mira.
 */
test('DoD 9: lo que lleva más de un día se descarta y se dice cuánto', async ({ browser }) => {
  const a = await entrar(browser, 'red7')
  const gid = await grupoCon(a.page, 'Caduca')
  const usuario = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!.user_id

  await a.page.evaluate(({ gid, usuario }) => new Promise<void>((resolve) => {
    const req = indexedDB.open('super', 1)
    req.onsuccess = () => {
      const t = req.result.transaction('cola', 'readwrite').objectStore('cola')
      t.put({
        id: 'viejo', usuario, grupo: gid, nombre: 'caducado', cantidad: null,
        creado: Date.now() - 25 * 60 * 60 * 1000,
      })
      t.transaction.oncomplete = () => resolve()
    }
  }), { gid, usuario })

  await a.page.goto(`/g/${gid}`)
  await expect(a.page.getByTestId('notice')).toContainText(/se descartó 1 producto/i)
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(0)
  expect(await colaEn(a.page), 'la entrada caducada sigue en el disco').toEqual([])
  await a.ctx.close()
})

/**
 * I5 / DoD 25 — Una carga que falla no puede llevarse la instantánea por delante.
 * Medido en la revisión: con la base pausada, el payload llega con la lista vacía
 * y su clase de error, y guardarla borraba lo último bueno **justo** en el
 * escenario para el que existe.
 */
test('DoD 25: una carga que falla no borra la instantánea', async ({ browser }) => {
  const a = await entrar(browser, 'red13')
  const gid = await grupoCon(a.page, 'NoBorra')
  await apuntar(a.page, 'canela')
  await expect(a.page.getByTestId('item')).toHaveCount(1)
  await a.page.goto(`/g/${gid}`)
  await a.page.waitForTimeout(500)

  // La base deja de contestar y se recarga: la carga trae la lista vacía.
  await a.page.route(/\/rest\/v1\//, r => r.abort('connectionfailed'))
  await a.page.reload().catch(() => {})
  await a.page.waitForTimeout(1_000)

  const guardada = await a.page.evaluate(() => new Promise<number>((resolve) => {
    const r = indexedDB.open('super', 1)
    r.onsuccess = () => {
      const t = r.result.transaction('listas', 'readonly').objectStore('listas').getAll()
      t.onsuccess = () => resolve(t.result.filter(Array.isArray).flat().length)
      t.onerror = () => resolve(-1)
    }
  }))
  expect(guardada, 'la carga fallida borró la última lista conocida').toBeGreaterThan(0)
  await a.ctx.close()
})

/** R5/R6 / DoD 11 — cerrar sesión borra lo local; caducar la sesión no. */
test('DoD 30: salir con la cola llena vacía el dispositivo', async ({ browser }) => {
  const a = await entrar(browser, 'red8')
  const gid = await grupoCon(a.page, 'Salir')
  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await apuntar(a.page, 'harina')
  await expect(a.page.getByTestId('item-pendiente')).toHaveCount(1)
  expect(await colaEn(a.page), 'no se guardó nada en el dispositivo').toHaveLength(1)
  expect(await listasEn(a.page), 'no se guardó ninguna lista').not.toEqual([])

  /**
   * El cierre explícito, en **este mismo dispositivo** y con la cola llena. La
   * primera versión abría un contexto nuevo, cuyo almacén estaba vacío antes de
   * pulsar: la aserción no podía fallar, y quitar `olvidarTodo` entero la dejaba
   * verde.
   */
  await a.ctx.setOffline(false)
  await a.page.goto('/')
  await a.page.getByTestId('signout').click()
  await a.page.waitForURL(/\/login/)
  expect(await colaEn(a.page), 'salir dejó la cola del usuario en el dispositivo').toEqual([])
  expect(await listasEn(a.page), 'salir dejó la lista del usuario en el dispositivo').toEqual([])
  await a.ctx.close()
  expect(gid).toBeTruthy()
})

/** R5 / DoD 11 — una sesión caducada no es un cierre: lo apuntado espera. */
test('DoD 11: caducar la sesión no se lleva lo apuntado', async ({ browser }) => {
  const a = await entrar(browser, 'red8b')
  await grupoCon(a.page, 'Caducar')
  await a.ctx.setOffline(true)
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await apuntar(a.page, 'levadura')
  expect(await colaEn(a.page)).toHaveLength(1)

  // Se le quitan las cookies: es el mismo usuario, sólo que sin sesión válida.
  await a.ctx.setOffline(false)
  await a.ctx.clearCookies()
  await a.page.goto('/login').catch(() => {})
  expect(await colaEn(a.page), 'una sesión caducada se llevó la cola por delante').toHaveLength(1)
  await a.ctx.close()
})

/**
 * R9 / DoD 14 — El motivo por el que existe el service worker: abrir **sin red y
 * desde cero**. Sin él esto da la pantalla de error del navegador.
 */
test('DoD 14 y 21: sin red y desde cero, el shell enseña la última lista', async ({ browser }) => {
  const a = await entrar(browser, 'red9')
  const gid = await grupoCon(a.page, 'Frio')
  await a.page.goto(`/g/${gid}`)
  await apuntar(a.page, 'membrillo')
  await expect(a.page.getByTestId('item')).toHaveCount(1)
  await a.page.evaluate(() => navigator.serviceWorker.ready)

  // Pestaña nueva, sin red: el documento sólo puede venir del shell precacheado,
  // y la lista sólo de la instantánea local.
  await a.ctx.setOffline(true)
  const fria = await a.ctx.newPage()
  await fria.goto(`/g/${gid}`).catch(() => {})
  await expect(fria.getByTestId('sin-red'), 'el arranque en frío sin red no pintó nada')
    .toBeVisible({ timeout: 20_000 })
  await expect(fria.getByTestId('sin-red')).toContainText(SIN_RED_CON_COPIA)
  await expect(fria.getByTestId('item').first()).toContainText('membrillo')
  await a.ctx.close()
})

/** I2 / DoD 22 — borde 5: un grupo que nunca se abrió no se puede enseñar. */
test('DoD 22: un grupo nunca abierto, sin red, dice que hace falta conexión', async ({ browser }) => {
  const a = await entrar(browser, 'red11')
  const gid = await grupoCon(a.page, 'Nunca')
  await a.page.goto(`/g/${gid}`)
  await a.page.evaluate(() => navigator.serviceWorker.ready)

  await a.ctx.setOffline(true)
  const fria = await a.ctx.newPage()
  await fria.goto('/g/00000000-0000-4000-8000-0000000000aa').catch(() => {})
  await expect(fria.getByTestId('sin-instantanea')).toContainText(SIN_INSTANTANEA, { timeout: 20_000 })
  await expect(fria.getByTestId('item')).toHaveCount(0)
  await a.ctx.close()
})

/**
 * I1 / DoD 19 y 20 — El fallo duro de A.1 que la revisión midió: el documento
 * cacheado llevaba el nombre del grupo y sus ítems, sobrevivía al cierre de sesión
 * y otro usuario del mismo dispositivo lo leía con sólo navegar.
 */
test('DoD 19 y 20: en la caché no hay datos de nadie, y B no ve lo de A', async ({ browser }) => {
  const ctx = await browser.newContext()
  const tarroA = nuevoTarro()
  const flujoA = await nuevoFlujoPkce('redA', tarroA)
  await ctx.addCookies(paraNavegador(tarroA))
  const paginaA = await ctx.newPage()
  await paginaA.goto(flujoA.callbackUrl)
  await paginaA.waitForLoadState('networkidle')
  const gid = await grupoCon(paginaA, 'Confidencial')
  await apuntar(paginaA, 'LentejasSecretas')
  await expect(paginaA.getByTestId('item')).toHaveCount(1)
  await paginaA.goto(`/g/${gid}`)
  await paginaA.evaluate(() => navigator.serviceWorker.ready)

  // DoD 19 — nada de A vive en Cache Storage.
  const guardado = await paginaA.evaluate(async () => {
    const fuera: { url: string; cuerpo: string }[] = []
    for (const n of await caches.keys()) {
      for (const p of await (await caches.open(n)).keys()) {
        const r = await (await caches.open(n)).match(p)
        fuera.push({ url: p.url, cuerpo: (await r!.text()).slice(0, 200_000) })
      }
    }
    return fuera
  })
  expect(guardado.length, 'no se cacheó nada: el criterio sería vacío').toBeGreaterThan(0)
  for (const { url, cuerpo } of guardado) {
    expect(url, 'una respuesta de datos acabó en caché').not.toContain('/rest/v1')
    expect(url, 'una respuesta de sesión acabó en caché').not.toContain('/auth/')
    expect(cuerpo, `${url} guarda el identificador del grupo`).not.toContain(gid)
    expect(cuerpo, `${url} guarda el nombre de un ítem`).not.toContain('LentejasSecretas')
  }

  // DoD 20 — B entra en el MISMO dispositivo y no ve nada de A, ni sin red.
  const tarroB = nuevoTarro()
  const flujoB = await nuevoFlujoPkce('redB', tarroB)
  await ctx.clearCookies()
  await ctx.addCookies(paraNavegador(tarroB))
  const paginaB = await ctx.newPage()
  await paginaB.goto(flujoB.callbackUrl)
  await paginaB.waitForLoadState('networkidle')
  await ctx.setOffline(true)
  const friaB = await ctx.newPage()
  await friaB.goto(`/g/${gid}`).catch(() => {})
  await expect(friaB.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await expect(friaB.getByTestId('item'), 'B ve la lista de A en el mismo dispositivo')
    .toHaveCount(0)
  await ctx.close()
})

/**
 * R9 / DoD 15 — La mitad de navegador del criterio que la spec escribió: tras
 * usar la app con red, ninguna caché guarda datos ni sesión.
 */
test('DoD 15: las cachés no guardan datos ni sesión', async ({ browser }) => {
  const a = await entrar(browser, 'red10')
  const gid = await grupoCon(a.page, 'Cachés')
  await a.page.goto(`/g/${gid}`)
  await apuntar(a.page, 'cafe')
  await expect(a.page.getByTestId('item')).toHaveCount(1)
  await a.page.evaluate(() => navigator.serviceWorker.ready)

  const urls = await a.page.evaluate(async () => {
    const fuera: string[] = []
    for (const n of await caches.keys()) {
      for (const p of await (await caches.open(n)).keys()) fuera.push(p.url)
    }
    return fuera
  })
  expect(urls.length, 'no se cacheó nada: el criterio sería vacío').toBeGreaterThan(0)
  for (const u of urls) {
    expect(u, 'una respuesta de datos acabó en caché').not.toContain('/rest/v1')
    expect(u, 'una respuesta de sesión acabó en caché').not.toContain('/auth/')
  }

  /**
   * El purgado de versiones viejas (borde 7) **no se prueba aquí**: forzar una
   * activación exige publicar una segunda versión del fichero, y sin eso el
   * navegador reutiliza el worker que ya tiene. Se prueba en `unit/sw.test.ts`
   * ejecutando el fuente real, que es determinista.
   */
  await a.ctx.close()
})


/**
 * J2 — El camino por el que entra un usuario de verdad: **la portada, sin
 * sesión**. Es donde se instala el service worker, y era justo donde estaba roto:
 * `/sin-conexion` no era pública, el proxy la redirigía al login, y lo que se
 * guardaba bajo la clave del shell era la redirección. Como un service worker no
 * reinstala, quedaba envenenada para siempre.
 *
 * La suite entera no lo veía porque todos sus caminos entraban por
 * `/auth/callback`, que es un manejador de ruta sin layout: nadie registraba el
 * worker en ellos.
 */
test('DoD 33: el shell responde 200 sin cookies y sin redirección', async ({ browser }) => {
  const ctx = await browser.newContext()
  const res = await ctx.request.get(`${appOrigin()}/sin-conexion`, { maxRedirects: 0 })
  expect(res.status(), 'el proxy redirige el shell: se precachea la redirección').toBe(200)
  await ctx.close()
})

test('DoD 34 y 44: entrando por la portada anónima, el arranque en frío sin red pinta el shell',
  async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto('/')
    await shellGuardado(page)

    await ctx.setOffline(true)
    // Pestaña nueva: arranque en frío de verdad, sin router de Next en memoria.
    const frio = await ctx.newPage()
    await frio.goto('/')
    // Spec C / R4 — fuera de un grupo el banner ya no promete memoria: no hay
    // ninguna, y prometerla era el defecto que esta prueba fijaba sin querer.
    await expect(frio.getByTestId('sin-red')).toHaveText(SIN_RED_ESPERANDO)
    // DoD 44 — fuera de un grupo no se habla de «este grupo»: aquí no hay ninguno.
    await expect(frio.getByTestId('sin-instantanea')).toHaveText(SIN_RED_FUERA)

    // Y dentro de un grupo que nunca se abrió, lo que corresponde: no hay foto.
    const enGrupo = await ctx.newPage()
    await enGrupo.goto('/g/8f1f1f7a-0000-4000-8000-000000000000')
    await expect(enGrupo.getByTestId('sin-instantanea')).toHaveText(SIN_INSTANTANEA)
    await ctx.close()
  })

/**
 * J1 / A.1 — Dos personas, **un dispositivo**. Medido en la revisión: B se
 * quedaba `pending`, abría sin red la URL del grupo de A y veía su lista, porque
 * quién estaba dentro se registraba en la vista del grupo —una vista que un
 * `pending` no llega a ver— y nadie había apuntado que el dueño del dispositivo
 * había cambiado.
 */
test('DoD 36 y 37: un pending no ve, sin red, la lista del anterior en el mismo dispositivo',
  async ({ browser }) => {
    const ctx = await browser.newContext()
    const a = await entrarEn(ctx, 'disp-a')
    const gid = await grupoCon(a.page, 'Compartido')
    await apuntar(a.page, 'anchoas')
    await expect(a.page.getByTestId('item')).toHaveCount(1)
    await shellGuardado(a.page)
    expect(await ultimoUsuario(a.page), 'no se registró quién estaba dentro').toBe(a.id)

    await a.page.getByTestId('create-invite').click()
    const enlace = await a.page.getByTestId('invite-link').inputValue()

    // A se va sin pulsar «salir»: la sesión simplemente deja de valer.
    await ctx.clearCookies()

    // B entra en el mismo dispositivo. DoD 37: con haber pasado por la portada
    // basta — registrar quién está dentro no puede depender de qué vista se
    // rendere, y B no va a llegar a ver ninguna lista.
    const b = await entrarEn(ctx, 'disp-b')
    await expect.poll(() => ultimoUsuario(b.page), { timeout: 10_000 })
      .toBe(b.id)  // DoD 37

    // Y B se queda `pending` por el camino real: el enlace de invitación. Es la
    // puerta que la revisión midió abierta — la página de invitación no monta la
    // vista del grupo, así que quien registraba allí no registraba nada.
    await b.page.goto(enlace)
    await expect(b.page.getByTestId('pending')).toBeVisible()

    await ctx.setOffline(true)
    const frio = await ctx.newPage()
    await frio.goto(`/g/${gid}`)
    await expect(frio.getByTestId('sin-red')).toBeVisible()
    await expect(frio.getByTestId('sin-instantanea')).toHaveText(SIN_INSTANTANEA)
    await expect(frio.getByTestId('item')).toHaveCount(0)
    expect(await frio.locator('body').innerText(),
      'la lista de otro usuario, servida sin red en el mismo dispositivo').not.toContain('anchoas')
    await ctx.close()
  })

/**
 * J4 / R4 — El drenado, en la capa que el DoD de R4 declaró y nadie atacó: **dos
 * contextos**. Que la cola llegue a la base lo prueba una consulta; que la otra
 * persona lo vea sin recargar es otra cosa, y es la que el producto promete.
 *
 * Las sesiones van sembradas: lo que se mide aquí es la propagación del drenado,
 * no el login —que `DoD 5 y 6` ya atraviesa entero con un código real—, y la
 * cadena invitar/solicitar/aprobar por interfaz vive en `approve.spec.ts`.
 */
test('DoD 40: lo drenado aparece en la pestaña de la otra persona sin recargar',
  async ({ browser }) => {
    const owner = await createUser('drena-owner')
    const { groupId } = await makeGroup(owner, 'Drenaje')
    const socia = await createUser('drena-socia')
    await addActiveMember(owner, groupId, socia)

    const ctxA = await signedInContext(browser, owner)
    const pageA = await ctxA.newPage()
    await pageA.goto(`/g/${groupId}`)
    await expect(pageA.getByTestId('channel-live')).toHaveCount(1)

    const ctxB = await signedInContext(browser, socia)
    const pageB = await ctxB.newPage()
    await pageB.goto(`/g/${groupId}`)
    await expect(pageB.getByTestId('channel-live')).toHaveCount(1)

    await ctxA.setOffline(true)
    await expect(pageA.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
    await apuntar(pageA, 'berenjenas')
    await expect(pageA.getByTestId('item-pendiente')).toHaveCount(1)
    // Sin red no ha llegado a nadie: si ya estuviera, lo de abajo no probaría nada.
    await expect(pageB.getByTestId('item')).toHaveCount(0)

    await ctxA.setOffline(false)
    // Sin recargar: la pestaña de B lleva abierta desde antes de que existiera.
    await expect(pageB.getByTestId('item').first().getByLabel('Nombre'))
      .toHaveValue('berenjenas', { timeout: 30_000 })

    await ctxA.close(); await ctxB.close()
  })

/**
 * K4 / A.1 — La marca de quién estaba dentro dice **de quién** es la instantánea
 * guardada; no dice quién está mirando la pantalla. Medido con el navegador antes
 * del cambio: borradas todas las cookies y sin red, una pestaña nueva en la URL
 * del grupo pintaba los productos del anterior. No hacía falta ninguna
 * herramienta: bastaba navegar, que es el mismo argumento con el que la iteración
 * 2 calificó de fallo duro el documento cacheado.
 */
test('DoD 49 y 50: sin sesión en el dispositivo, el shell no pinta la lista de nadie',
  async ({ browser }) => {
    const ctx = await browser.newContext()
    const a = await entrarEn(ctx, 'sesion-a')
    const gid = await grupoCon(a.page, 'ConSesion')
    await apuntar(a.page, 'anchoas')
    await expect(a.page.getByTestId('item')).toHaveCount(1)
    await shellGuardado(a.page)

    await ctx.setOffline(true)
    // DoD 50 — con sesión sí se pinta. Sin esta mitad, lo de abajo pasaría
    // también con un shell que no enseñara nunca nada.
    const conSesion = await ctx.newPage()
    await conSesion.goto(`/g/${gid}`)
    await expect(conSesion.getByTestId('item')).toHaveCount(1)
    await expect(conSesion.getByTestId('item')).toContainText('anchoas')

    // DoD 49 — y sin ella, no. La instantánea sigue en el disco: lo que cambia es
    // que ya no hay nadie dentro de este dispositivo a quien enseñársela.
    await ctx.clearCookies()
    const sinSesion = await ctx.newPage()
    await sinSesion.goto(`/g/${gid}`)
    await expect(sinSesion.getByTestId('sin-red')).toBeVisible()
    await expect(sinSesion.getByTestId('sin-instantanea')).toHaveText(SIN_INSTANTANEA)
    await expect(sinSesion.getByTestId('item')).toHaveCount(0)
    expect(await sinSesion.locator('body').innerText(),
      'la lista de alguien, servida sin red y sin sesión ninguna').not.toContain('anchoas')
    await ctx.close()
  })

/**
 * N1 / deuda 34 — El caso que la cola NO cubría: la red cae **entre el pulsar y
 * la respuesta**. Aquí `setOffline` no vale, porque lo que se prueba es
 * justamente que el navegador se sigue creyendo conectado: `sinRed` es falso
 * todo el rato, el banner de sin red no aparece, y aun así lo apuntado no se
 * pierde. Se corta la petición, no la interfaz.
 */
test('DoD 7: la red cae entre pulsar y responder, y lo apuntado no se pierde',
  async ({ browser }) => {
    const a = await entrar(browser, 'deuda34')
    const gid = await grupoCon(a.page, 'Deuda34')
    await expect(a.page.getByTestId('channel-live')).toHaveCount(1)

    let cortado = true
    await a.ctx.route('**/rest/v1/items**', async route => {
      if (cortado && route.request().method() === 'POST') return route.abort('failed')
      return route.continue()
    })

    // Gesto, no API: se teclea tecla a tecla y se pulsa el botón.
    await a.page.getByTestId('item-name').click()
    await a.page.getByTestId('item-name').pressSequentially('lentejas')
    await a.page.getByTestId('add-item').click()

    // La app NUNCA se creyó sin red: ése es el caso que la deuda describe.
    await expect(a.page.getByTestId('sin-red')).toHaveCount(0)
    await expect(a.page.getByTestId('item-pendiente')).toContainText('lentejas')
    await expect(a.page.getByTestId('item-name')).toHaveValue('')

    const antes = await admin.from('items').select('id', { count: 'exact', head: true })
      .eq('group_id', gid).is('deleted_at', null)
    expect(antes.count, 'se escribió en la base con la petición cortada').toBe(0)

    // Vuelve la red. Nadie toca el estado de red del navegador ni recarga.
    cortado = false
    await expect(a.page.getByTestId('item-pendiente')).toHaveCount(0, { timeout: 40_000 })
    await expect(a.page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('lentejas')
    const despues = await admin.from('items').select('name')
      .eq('group_id', gid).is('deleted_at', null)
    expect(despues.data?.map(x => x.name)).toEqual(['lentejas'])
    await a.ctx.close()
  })

/**
 * Spec C / iteración 2 / R4 — Los ítems que dicen «navegador», en el navegador.
 *
 * La iteración 1 no añadió ni un caso aquí y cinco ítems nombraban esta capa
 * (§E.1). El peor era el 13: que la cáscara no pinte el **nombre** de otro
 * usuario no lo vigilaba nadie, y es la mitad nueva de una regla de A.1.
 */
test('DoD 8 y 9: desde la cáscara se apunta, y dice de qué grupo es', async ({ browser }) => {
  const a = await entrar(browser, 'cascara1')
  await grupoCon(a.page, 'Familia Alba')
  await apuntar(a.page, 'membrillo')
  await expect(a.page.getByTestId('item')).toHaveCount(1)
  await shellGuardado(a.page)

  // Recargar sin red: lo que se monta es la cáscara, no la vista.
  await a.ctx.setOffline(true)
  await a.page.reload().catch(() => { /* sin red, el documento lo sirve el shell */ })
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  await expect(a.page.getByTestId('nombre-grupo'),
    'la cáscara enseña la lista sin decir de qué grupo es').toHaveText('Familia Alba')

  // Y se puede apuntar, que es el escenario que motivó la PWA.
  await a.page.getByTestId('item-name').fill('aceitunas')
  await a.page.getByTestId('add-item').click()
  await expect(a.page.getByTestId('pendiente')).toContainText('aceitunas')

  // En la cola de verdad, no sólo en pantalla.
  const enCola = await a.page.evaluate(() => new Promise<string[]>((ok) => {
    const req = indexedDB.open('super', 1)
    req.onerror = () => ok([])
    req.onsuccess = () => {
      const p = req.result.transaction('cola', 'readonly').objectStore('cola').getAll()
      p.onsuccess = () => ok((p.result as { nombre: string }[]).map(x => x.nombre))
      p.onerror = () => ok([])
    }
  }))
  expect(enCola, 'lo apuntado en la cáscara no llegó a la cola').toContain('aceitunas')
  await a.ctx.close()
})

/**
 * DoD 10 — El escenario entero, sin que nadie pulse nada: cortar, recargar,
 * apuntar, restaurar, y que la cáscara se quite sola de en medio.
 */
test('DoD 10: al volver la red la cáscara se recupera sola', async ({ browser }) => {
  const a = await entrar(browser, 'cascara2')
  await grupoCon(a.page, 'Familia Alba')
  await apuntar(a.page, 'membrillo')
  await shellGuardado(a.page)

  await a.ctx.setOffline(true)
  await a.page.reload().catch(() => {})
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })

  // Vuelve la red y **no se toca nada**: el sondeo tiene que hacer el resto.
  await a.ctx.setOffline(false)
  /**
   * El discriminador **no** puede ser `add-item`: desde esta spec la cáscara
   * también lo tiene. Se mira algo que sólo la vista de verdad trae —el canal en
   * vivo y la invitación— porque recuperarse es volver ahí, no maquillar esto.
   */
  await expect(a.page.getByTestId('create-invite'),
    'la red volvió y la cáscara siguió siendo la cáscara').toBeVisible({ timeout: 60_000 })
  await expect(a.page.getByTestId('sin-red')).toHaveCount(0)
  // En la vista el nombre vive en el `value` del campo, no en el texto del `li`.
  await expect(a.page.getByTestId('item').first().locator('input').first())
    .toHaveValue('membrillo')
  await a.ctx.close()
})

/**
 * DoD 11 — La mitad **nueva** de la regla K4: sin sesión en el dispositivo no se
 * pinta la lista de nadie, y tampoco el **nombre** de su grupo.
 */
test('DoD 11: sin sesión, la cáscara no pinta el nombre del grupo ajeno', async ({ browser }) => {
  const a = await entrar(browser, 'cascara3')
  await grupoCon(a.page, 'Familia Secreta')
  await apuntar(a.page, 'anchoas')
  await shellGuardado(a.page)
  const gid = a.page.url().split('/g/')[1]

  // Se van las cookies: el dispositivo sigue teniendo la instantánea, pero no
  // hay nadie dentro. Es el caso que K4 midió con productos, y ahora con nombre.
  await a.ctx.clearCookies()
  await a.ctx.setOffline(true)
  const fria = await a.ctx.newPage()
  await fria.goto(`/g/${gid}`).catch(() => {})
  await expect(fria.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  const texto = await fria.locator('main').innerText()
  expect(texto, 'la lista del anterior, sin sesión ninguna').not.toContain('anchoas')
  expect(texto, 'el NOMBRE del grupo del anterior, sin sesión ninguna')
    .not.toContain('Familia Secreta')
  await a.ctx.close()
})

/**
 * DoD 14 / iteración 3 — El ítem que el usuario marcó como el que importa,
 * medido por **comportamiento** y no por construcción.
 *
 * La versión anterior creaba un `Request` en la página y miraba su `mode`: eso
 * afirma una constante del estándar Fetch, y pasaba verde con el manejador
 * `fetch` del worker entero neutralizado. Demostrado en la revisión.
 *
 * Lo que se afirma ahora: con red la sonda resuelve 200 y HTML; **sin red
 * rechaza**. Si el worker la sirviera de caché —metiendo `/g/` entre los
 * estáticos, por ejemplo— la sonda de arriba la habría guardado y la de abajo
 * resolvería: sondear sin red acertaría siempre, la cáscara recargaría, volvería
 * a caer, y sería un bucle. Y además el documento del grupo estaría en un disco
 * compartido, que es §A.1.
 */
test('DoD 14: la sonda sale a la red y sin red rechaza', async ({ browser }) => {
  const a = await entrar(browser, 'cascara4')
  await grupoCon(a.page, 'Familia Alba')
  await shellGuardado(a.page)

  const conRed = await a.page.evaluate(async () => {
    const r = await fetch(window.location.href, { cache: 'no-store' })
    return {
      controlado: !!navigator.serviceWorker.controller,
      ok: r.ok, tipo: r.headers.get('content-type') ?? '',
    }
  })
  expect(conRed.controlado, 'el worker no controla la página: no se mide nada').toBe(true)
  expect(conRed.ok).toBe(true)
  expect(conRed.tipo).toContain('text/html')

  // Y el documento del grupo NO puede haber quedado guardado por el camino.
  const enCache = await a.page.evaluate(() => caches.match(window.location.href).then(r => !!r))
  expect(enCache, 'el documento del grupo acabó en la caché compartida: A.1').toBe(false)

  await a.ctx.setOffline(true)
  const sinRed = await a.page.evaluate(async () => {
    try { await fetch(window.location.href, { cache: 'no-store' }); return 'resolvió' }
    catch { return 'rechazó' }
  })
  expect(sinRed, 'la sonda se resolvió sin red: el worker la sirve de caché, y eso es un bucle')
    .toBe('rechazó')
  await a.ctx.close()
})

/**
 * DoD 1 de la iteración 3 — El camino que la iteración 2 rompió: sesión caducada.
 * `proxy.ts` redirige `/g/<id>` a `/login`, y exigir `!res.redirected` dejaba la
 * cáscara encerrada con la red ya de vuelta. Medido entonces: 40 s y seguía.
 */
test('DoD 1 (iter 3): sin sesión, la cáscara también se recupera al volver la red',
  async ({ browser }) => {
    const a = await entrar(browser, 'cascara6')
    await grupoCon(a.page, 'Familia Alba')
    await apuntar(a.page, 'membrillo')
    await shellGuardado(a.page)
    const gid = a.page.url().split('/g/')[1]

    // La sesión se va mientras no hay red: la cáscara sigue en pie.
    await a.ctx.clearCookies()
    await a.ctx.setOffline(true)
    await a.page.goto(`/g/${gid}`).catch(() => {})
    await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })

    // Vuelve la red y no se toca nada: tiene que salir de aquí, aunque el
    // destino sea el login.
    await a.ctx.setOffline(false)
    await expect(a.page.getByTestId('sin-red'),
      'la sesión caducada deja la cáscara encerrada para siempre').toHaveCount(0, { timeout: 60_000 })
    await a.ctx.close()
  })

/**
 * Iteración 4 / DoD 2 — La guarda de envío, en la capa donde la `ref` es la que
 * salva: dos toques **dentro de la misma tarea**, con cambio de valor en medio.
 *
 * La versión anterior usaba `dblclick`, y no podía ponerse roja: reparte los dos
 * clics en tareas distintas, React vuelca el estado entre medias, `disabled` ya
 * está puesto y el segundo clic cae en la rama del campo vacío. Es exactamente el
 * defecto que esta misma iteración había diagnosticado en el gemelo de jsdom,
 * reproducido en el gemelo de navegador escrito para cubrirlo.
 */
test('DoD 2 (iter 4): dos envíos en la misma tarea encolan una sola vez', async ({ browser }) => {
  const a = await entrar(browser, 'cascara7')
  await grupoCon(a.page, 'Familia Alba')
  await shellGuardado(a.page)
  await a.ctx.setOffline(true)
  await a.page.reload().catch(() => {})
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })

  /**
   * Se envía por **formulario**, no por el botón, y ahí está la diferencia
   * medida: React vuelca los eventos discretos de forma síncrona, así que tras un
   * `click()` el botón ya está `disabled` y el segundo clic no llega. El
   * `requestSubmit` no pasa por el botón, y `disabled` no lo detiene.
   *
   * Medido el 2026-09-13, tres pasadas por lado: con la `ref` queda **1**
   * encolado; quitándola —y dejando `disabled` puesto— quedan **2**. Es el único
   * camino que demuestra para qué existe la `ref`, y es un camino real: la tecla
   * «ir» del teclado del móvil envía por formulario.
   */
  await a.page.evaluate(() => {
    const campo = document.querySelector('[data-testid=item-name]') as HTMLInputElement
    const form = campo.closest('form') as HTMLFormElement
    const poner = (v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(campo, v)
      campo.dispatchEvent(new Event('input', { bubbles: true }))
    }
    poner('aceitunas'); form.requestSubmit()
    // Sin ceder el hilo, y sin pasar por el botón: sólo la `ref` puede parar esto.
    poner('vino');      form.requestSubmit()
  })

  await expect(a.page.getByTestId('pendiente')).toHaveCount(1)
  const enCola = await a.page.evaluate(() => new Promise<number>((ok) => {
    const req = indexedDB.open('super', 1)
    req.onerror = () => ok(-1)
    req.onsuccess = () => {
      const p = req.result.transaction('cola', 'readonly').objectStore('cola').getAll()
      p.onsuccess = () => ok((p.result as unknown[]).length)
      p.onerror = () => ok(-1)
    }
  }))
  expect(enCola, 'los dos envíos de la misma tarea encolaron dos veces').toBe(1)
  await a.ctx.close()
})

/** DoD 16 — La única vía de escape de la cáscara se puede tocar con el pulgar. */
test('DoD 16: la salida de la cáscara mide al menos 44 px', async ({ browser }) => {
  const a = await entrar(browser, 'cascara5')
  await grupoCon(a.page, 'Familia Alba')
  await shellGuardado(a.page)
  await a.ctx.setOffline(true)
  await a.page.reload().catch(() => {})
  await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
  const caja = await a.page.getByTestId('salida').boundingBox()
  expect(caja?.height ?? 0, 'la única salida no se puede tocar').toBeGreaterThanOrEqual(44)
  await a.ctx.close()
})

/**
 * Spec C / iteración 5 / DoD 1 — Pulsar la salida no despierta el segundo bucle.
 *
 * Medido el 2026-09-13 con `next/link`: pulsar `← Grupos` sin red hace fallar un
 * fetch del framework, y eso arranca el bucle de
 * `next/dist/esm/client/components/offline.js` —cadencia 500ms/1s/2s/3s, sin
 * rendirse—: **6 HEAD en 10 s** al documento **autenticado** del grupo, encima de
 * las 2 sondas por minuto que esta pantalla ya hace. Unas 20 peticiones por
 * minuto contra un servicio que puede estar pausado, que es el escenario para el
 * que existe todo esto.
 *
 * Con un enlace normal la navegación la intercepta el service worker y el
 * framework no ve ningún fetch fallado. La regla del linter queda silenciada en
 * `app/sin-conexion/page.tsx` con su motivo, y declarada en el inventario de
 * `unit/puerta-lint.test.ts`.
 */
test('DoD 1 (iter 5): pulsar la salida sin red no despierta el sondeo del framework',
  async ({ browser }) => {
    const a = await entrar(browser, 'cascara8')
    await grupoCon(a.page, 'Familia Alba')
    await shellGuardado(a.page)

    const vistas: string[] = []
    a.page.on('request', r => vistas.push(r.method()))

    await a.ctx.setOffline(true)
    await a.page.reload().catch(() => {})
    await expect(a.page.getByTestId('sin-red')).toBeVisible({ timeout: 20_000 })
    const base = vistas.length
    await a.page.getByTestId('salida').click().catch(() => { /* sin red, no llega */ })
    await a.page.waitForTimeout(10_000)

    const heads = vistas.slice(base).filter(m => m === 'HEAD').length
    expect(heads, `el bucle del framework arrancó: ${heads} HEAD en 10 s`).toBe(0)
    await a.ctx.close()
  })
