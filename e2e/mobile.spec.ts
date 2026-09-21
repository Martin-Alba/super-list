import { test, expect } from '@playwright/test'
import { api, createUser, makeGroup, makeInvite, addActiveMember, signedInContext } from './fixtures'

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
  /**
   * Spec J — la cantidad pasa de `'12 unidades'` a `'99'`, y para lo que esta prueba mide
   * —desbordamiento a 390 px— es **el peor caso de verdad**: desde J-R1 la columna no puede
   * contener nada más ancho que dos dígitos, así que estresar con once caracteres medía una
   * anchura que el producto ya no puede producir.
   *
   * Y se comprueba el error del insert, que no se comprobaba: sin esto la restricción nueva
   * habría dejado la lista vacía y la prueba de desbordamiento habría pasado por no tener
   * nada que desbordar.
   */
  const puesto = await client.from('items').insert({
    group_id: groupId, created_by: owner.id,
    name: 'un producto con un nombre francamente larguísimo para forzar el desbordamiento',
    quantity: '99',
  })
  expect(puesto.error, 'no se pudo sembrar el ítem: no hay nada que pueda desbordar').toBeNull()
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

  /**
   * Spec J / k8 — **El mando del enlace, que sólo existe después de generarlo.**
   *
   * No estaba en la lista de arriba porque no está en pantalla hasta que se pulsa «Generar»,
   * y un `getByTestId` sobre algo que no existe no falla: devuelve una caja nula y el bucle
   * ni lo mira. Hoy cumple por el texto que lleva dentro, no por declaración, que es
   * literalmente la cicatriz R9 —«declaraba alto mínimo pero no ancho»—.
   *
   * Cuál de los dos se pinta lo decide el navegador, así que se mide **el que haya**: en el
   * Chromium de Playwright no hay `navigator.share` y sale `copy-invite`.
   */
  await page.getByTestId('create-invite').click()
  const mando = page.getByTestId('copy-invite').or(page.getByTestId('share-invite'))
  await expect(mando, 'no se pintó ninguno de los dos mandos del enlace').toBeVisible()
  const cajaMando = await mando.boundingBox()
  expect(cajaMando!.height, `el mando del enlace mide ${cajaMando!.height}px de alto`)
    .toBeGreaterThanOrEqual(44)
  // m8 — **Y el ancho**, que es lo que la cicatriz R9 midió: «declaraba alto mínimo y no ancho».
  expect(cajaMando!.width, `el mando del enlace mide ${cajaMando!.width}px de ancho`)
    .toBeGreaterThanOrEqual(44)
  await ctx.close()
})

/**
 * Spec J / m8 — **El OTRO mando, el que este navegador no pinta.**
 *
 * El `.or()` de arriba resuelve al único que existe —`copy-invite`, porque el Chromium de
 * Playwright no trae `navigator.share`—, así que `share-invite` no se medía nunca. Y su
 * inalcanzabilidad **no estaba ganada**: sembrar `navigator.share` lo pinta, que es lo que hace
 * esta prueba. Es el mando que ve un móvil, o sea el único que mucha gente va a tocar.
 */
test('el mando de compartir mide al menos 44x44 cuando el navegador lo ofrece', async ({ browser }) => {
  const owner = await createUser('mob-owner3')
  const { groupId } = await makeGroup(owner)
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  // Se siembra antes de cargar: `puedeCompartir` se decide en el handler del click, con el
  // `navigator` que haya entonces.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
  })
  await page.goto(`/g/${groupId}`)

  await page.getByTestId('create-invite').click()
  const compartir = page.getByTestId('share-invite')
  await expect(compartir, 'con navigator.share sembrado no se pintó el mando de compartir')
    .toBeVisible()
  await expect(page.getByTestId('copy-invite'), 'se pintaron los dos').toHaveCount(0)
  const caja = await compartir.boundingBox()
  expect(caja!.height, `share-invite mide ${caja!.height}px de alto`).toBeGreaterThanOrEqual(44)
  expect(caja!.width, `share-invite mide ${caja!.width}px de ancho`).toBeGreaterThanOrEqual(44)
  await ctx.close()
})

/**
 * Spec H / i1-R6 — **Los mandos nuevos, con los paneles ABIERTOS y con un nombre largo.**
 *
 * Las dos guardas de arriba no enumeraban `transfer`, `delete-group` ni los cuatro `confirm-*`, y
 * nunca abrían los paneles. Por eso el desbordamiento de i1-R5 pasó la verja entera: el panel de
 * confirmar transferencia medía 416 px a 390 de pantalla y el botón «No» quedaba 30 px fuera, y
 * ninguna guarda miraba ahí.
 *
 * El nombre largo no es decorativo: lo escribe la persona y `profiles` no lo acota, así que es la
 * entrada que rompe. Con un nombre corto esta fila pasaría igual con el defecto puesto.
 */
test('los mandos de propiedad no desbordan a 390 px, con los paneles abiertos', async ({ browser }) => {
  const owner = await createUser('mob-owner3')
  /**
   * El nombre largo es el de la **persona**, porque es lo que pintan los mandos que esta fila
   * vigila y porque lo escribe quien se registra, sin cota en `profiles`.
   *
   * *(El comentario anterior decía que el desbordamiento de la cabecera «queda anotado en la deuda
   * con su medida» y **era falso**: no había tal anotación. Lo midió la revisión —`grep` en `docs/`
   * daba cero—. Ahora sí está, y además la causa raíz quedó arreglada: ver «i2-4».)*
   */
  const { groupId } = await makeGroup(owner, 'Familia')
  const otro = await createUser('mob-nombre-larguisimo-de-persona-que-no-cabe-en-la-fila')
  await addActiveMember(owner, groupId, otro)

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/g/${groupId}`)

  const cabe = async (id: string) => {
    const box = await page.getByTestId(id).first().boundingBox()
    expect(box, `${id} no está en pantalla`).not.toBeNull()
    expect(box!.height, `${id} mide ${box!.height}px de alto`).toBeGreaterThanOrEqual(44)
    expect(box!.x, `${id} empieza fuera de pantalla en x=${box!.x}`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width,
      `${id} se sale por la derecha: acaba en ${box!.x + box!.width} de 390`).toBeLessThanOrEqual(390)
  }

  await cabe('transfer'); await cabe('delete-group')
  expect(await noHorizontalScroll(page), 'la pantalla del owner desborda').toBe(true)

  await page.getByTestId('transfer').click()
  await cabe('confirm-transfer-yes'); await cabe('confirm-transfer-no')
  expect(await noHorizontalScroll(page), 'el panel de transferir desborda').toBe(true)
  await page.getByTestId('confirm-transfer-no').click()

  await page.getByTestId('delete-group').click()
  await cabe('confirm-delete-yes'); await cabe('confirm-delete-no')
  expect(await noHorizontalScroll(page), 'el panel de borrar desborda').toBe(true)

  await ctx.close()
})

/**
 * Spec H / i2-R3 — **La causa raíz, no un `span` cada vez.**
 *
 * `body` es `flex … flex-col` y cada `main` era `mx-auto … max-w-md`. Un margen automático en el eje
 * transversal **suprime el `align-self: stretch`**, así que el `main` se dimensionaba por contenido y
 * se topaba en 448 px: con la pantalla en 390, cualquier cosa que no pudiera encoger —un `truncate`,
 * que fija `white-space: nowrap`— estiraba la página. Lo diagnosticó la revisión; yo había llegado
 * hasta el síntoma y no hasta esto.
 *
 * Estas dos filas atacan las dos formas que lo producían, y las dos pasaban antes con entradas
 * cortas: un nombre de **grupo** de un solo token —783 px medidos por la revisión— y un nombre de
 * **persona** largo en la fila de solicitud, donde «Rechazar» perdía 42 de sus 86 px fuera de
 * pantalla y el owner no podía rechazarla.
 */
test('i2-4: un nombre de grupo de un solo token no desborda a 390 px', async ({ browser }) => {
  const owner = await createUser('mob-owner4')
  const { groupId } = await makeGroup(owner, 'Familiaalbaconunnombredeunsolotokensinespaciosningunos')
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/g/${groupId}`)
  await expect(page.getByTestId('group-name')).toHaveCount(1)
  expect(await noHorizontalScroll(page),
    'la cabecera con un nombre sin espacios desborda la pantalla').toBe(true)
  await ctx.close()
})

/**
 * Spec H / i3-R1 — **El nombre del grupo, en los tres sitios donde sale.**
 *
 * La causa del contenedor se cerró en la iteración 2; lo que seguía desbordando es el texto que
 * escribe la persona. `groups.name` acepta 200 caracteres y su único `check` es que no esté en
 * blanco —no mira el formato—, así que un nombre **sin un solo espacio** es una entrada legítima.
 * Con espacios ninguna de estas tres filas se pondría roja, y ése es justo el motivo por el que las
 * guardas anteriores no vieron nada: la entrada, no la pantalla.
 *
 * Medido antes del arreglo, a 390 px: portada **473**, panel de borrado **430** y panel de
 * transferir **414–417** (éste se arregló una vuelta más tarde: el ciclo lo había medido dos veces y
 * lo dejó caer). El nombre sale en **cuatro** sitios; el cuarto, la cáscara sin conexión, se buscó y
 * **no tenía el defecto** — lo cubre `e2e/sin-red.spec.ts` › «DoD 8 y 9» como `[REGRESIÓN]`.
 */
const TOKEN = 'Familiaalbaconunnombredeunsolotokensinespaciosningunos'

test('i3-1: la portada no desborda con un nombre de un solo token', async ({ browser }) => {
  const owner = await createUser('mob-owner6')
  await makeGroup(owner, TOKEN)
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByTestId('groups').getByRole('link'),
    'el grupo no está listado: el escenario no existe').toHaveCount(1)
  expect(await noHorizontalScroll(page), 'la portada desborda').toBe(true)
  await ctx.close()
})

test('i3-2: el panel de borrado no desborda, y su frase sigue entera', async ({ browser }) => {
  const owner = await createUser('mob-owner7')
  const { groupId } = await makeGroup(owner, TOKEN)
  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/g/${groupId}`)
  await page.getByTestId('delete-group').click()
  const panel = page.getByTestId('confirm-delete')
  await expect(panel).toHaveCount(1)
  expect(await noHorizontalScroll(page), 'el panel de borrado desborda').toBe(true)
  /**
   * Y la frase entera, porque aquí el arreglo **no** podía ser recortar: el nombre va dentro de la
   * frase y `truncate` se habría llevado por delante «No se puede deshacer», que es lo que hay que
   * leer antes de pulsar. Esta línea se pone roja si alguien lo «arregla» recortando.
   */
  await expect(panel, 'la advertencia de irreversibilidad desapareció').toContainText(/no se puede deshacer/i)
  await ctx.close()
})

test('i4-1: el panel de transferir no desborda con un nombre de un solo token', async ({ browser }) => {
  /**
   * El gemelo de `i3-2`, y el ciclo lo midió **dos veces** antes de arreglarlo: 416 px en la
   * iteración 1 y 417 en la sonda de la iteración 2, que sigue en `.claude/fathom/` imprimiendo ese
   * número. Las dos veces se cayó sin fila, sin deuda y sin arreglo, mientras la iteración 3 le ponía
   * `break-words` a su hermano tres bloques más abajo. Una medida tomada y no escrita no se tomó.
   *
   * La entrada que discrimina es el nombre de la **persona**: `profiles.display_name` no tiene cota
   * ni check de formato, así que un token largo es legítimo.
   */
  const owner = await createUser('mob-owner8')
  const { groupId } = await makeGroup(owner, 'Familia')
  const otro = await createUser('mobsolicitanteconunnombredeunsolotokenlarguisimosinespacios')
  await addActiveMember(owner, groupId, otro)

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/g/${groupId}`)
  await page.getByTestId('transfer').click()
  const panel = page.getByTestId('confirm-transfer')
  await expect(panel).toHaveCount(1)
  expect(await noHorizontalScroll(page), 'el panel de transferir desborda').toBe(true)
  // Y la frase entera: recortarla escondería lo que se pierde al transferir.
  await expect(panel, 'la advertencia de lo que se pierde desapareció').toContainText(/dejarás de poder/i)
  await ctx.close()
})

test('i2-3: con un nombre largo, «Rechazar» es pulsable a 390 px', async ({ browser }) => {
  const owner = await createUser('mob-owner5')
  const { groupId } = await makeGroup(owner, 'Familia')
  const token = await makeInvite(owner, groupId)
  const guest = await createUser('mob-solicitante-con-un-nombre-larguisimo-que-no-cabe-en-la-fila')
  await (await api(guest)).rpc('request_join', { p_token: token })

  const ctx = await signedInContext(browser, owner)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/g/${groupId}`)
  await expect(page.getByTestId('pending-request'),
    'la solicitud no llegó: el escenario no existe').toHaveCount(1)

  for (const id of ['approve', 'reject']) {
    const box = await page.getByTestId(id).boundingBox()
    expect(box, `${id} no está en pantalla`).not.toBeNull()
    expect(box!.x + box!.width,
      `${id} se sale por la derecha: acaba en ${box!.x + box!.width} de 390`).toBeLessThanOrEqual(390)
  }
  expect(await noHorizontalScroll(page), 'la fila de solicitud desborda').toBe(true)
  await ctx.close()
})
