import { test, expect, type Browser } from '@playwright/test'
import { nuevoFlujoPkce, nuevoTarro, paraNavegador, CLAVE_COOKIE } from './pkce'
import { admin } from './fixtures'

/**
 * Los tres caminos de fallo se prueban por SEPARADO. Un solo caso de "sale un
 * aviso" los daría por buenos con dos de los tres rotos, que es exactamente el
 * estado que encontró el QA: uno callaba, otro enseñaba el texto crudo de
 * Postgres y el tercero decía que habías perdido el acceso cuando lo que había
 * caducado era la sesión.
 *
 * Ninguna sesión se siembra: se entra atravesando `/auth/callback` con un código
 * real. Lo único sembrado son las cookies verificadoras de PKCE, que en un login
 * de verdad las escribe el navegador al pulsar el botón. El tramo de Google no se
 * puede automatizar y queda declarado en la spec.
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

async function grupoCon(page: import('@playwright/test').Page, nombre: string) {
  await page.goto('/')
  await page.getByTestId('group-name').fill(nombre)
  await page.getByTestId('create-group').click()
  await page.waitForURL(/\/g\//)
  return page.url().split('/g/')[1]
}

test('DoD 2: un producto de sólo espacios avisa en vez de callar', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av1')
  await grupoCon(page, 'Avisos')
  await page.getByTestId('item-name').fill('     ')
  await page.getByTestId('add-item').click()
  await expect(page.getByTestId('notice'), 'medido en el QA: no pasaba nada y no se decía nada')
    .toBeVisible()
  await expect(page.getByTestId('notice')).toContainText(/nombre/i)
  await ctx.close()
})

test('DoD 3: un grupo de 201 caracteres no enseña el texto crudo de la base', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av2')
  await page.goto('/')
  await page.getByTestId('group-name').fill('z'.repeat(201))
  await page.getByTestId('create-group').click()
  const alerta = page.getByTestId('group-notice')
  await expect(alerta).toBeVisible()
  const texto = await alerta.innerText()
  expect(texto, 'el usuario ve nombres de tablas y restricciones de Postgres')
    .not.toMatch(/violates|constraint|relation |row-level|policy/i)
  await ctx.close()
})

test('DoD 5 y 6: la sesión caducada y la falta de acceso NO dicen lo mismo', async ({ browser }) => {
  // (5) token inválido -> PGRST301 -> sesión, con salida
  const a = await entrar(browser, 'av3')
  await grupoCon(a.page, 'Sesion')
  const cookies = await a.ctx.cookies()
  const sesion = cookies.filter(c => c.name.startsWith(CLAVE_COOKIE))
  await a.ctx.clearCookies()
  await a.ctx.addCookies(sesion.map(c => ({ ...c, value: 'base64-' + Buffer.from(
    JSON.stringify({ access_token: 'no.es.un.jwt', refresh_token: 'x', expires_at: 1 })).toString('base64') })))
  await a.page.getByTestId('item-name').fill('pan')
  await a.page.getByTestId('add-item').click()
  await expect(a.page.getByTestId('notice')).toBeVisible()
  await expect(a.page.getByTestId('notice'), 'una sesión caducada se anunciaba como pérdida de acceso')
    .toContainText(/sesión/i)
  await expect(a.page.getByTestId('volver-a-entrar'),
    'decirle que caducó sin manera de volver a entrar es un callejón').toBeVisible()

  await a.ctx.close()

  /**
   * S5 — Esto era `expect(await page.title()).toBeTruthy()`, que no afirma nada:
   * la revisión rompió `clasificar` a propósito y pasaba 3/3. Ahora se fuerza un
   * `42501` de RLS **con la sesión intacta** y se exige lo contrario: que hable de
   * acceso y que NO ofrezca volver a entrar, porque entrando no se arregla.
   */
  const b = await entrar(browser, 'av4')
  await grupoCon(b.page, 'ConSesion')
  /**
   * AF2 — Esto fabricaba la respuesta con `fulfill`, así que el test verificaba
   * **su propia siembra**: el cuerpo lo escribía él. Ahora la petición sale de
   * verdad y sólo se le cambia el grupo de destino por uno del que este usuario
   * no es miembro. RLS contesta el `42501` real, con el cuerpo real que PostgREST
   * produce — que es la superficie donde vive el requisito (§E.1).
   */
  const ajeno = '00000000-0000-4000-8000-0000000000ff'
  await b.page.route(/\/rest\/v1\/items/, async (ruta) => {
    const peticion = ruta.request()
    if (peticion.method() !== 'POST') return ruta.continue()
    const cuerpo = JSON.parse(peticion.postData() ?? '{}')
    await ruta.continue({ postData: JSON.stringify({ ...cuerpo, group_id: ajeno }) })
  })
  await b.page.getByTestId('item-name').fill('pan')
  await b.page.getByTestId('add-item').click()
  await expect(b.page.getByTestId('notice')).toContainText(/acceso a este grupo/i)
  await expect(b.page.getByTestId('notice'), 'una sesión válida no se arregla volviendo a entrar')
    .not.toContainText(/sesión/i)
  await expect(b.page.getByTestId('volver-a-entrar')).toHaveCount(0)
  /**
   * Y con la respuesta REAL delante: nada de lo que PostgREST manda llega a la
   * pantalla. Medido contra el entorno autoritativo, hoy `details` y `hint`
   * vienen `null` en los ocho errores —la revisión corrigió aquí una medida mía
   * tomada en `psql`, una capa por debajo—, así que esto no es la reproducción de
   * una fuga observada: es la comprobación de que si dejaran de venir nulos
   * tampoco pasarían.
   */
  const pantalla = await b.page.evaluate(() => document.body.innerText)
  for (const rastro of ['row-level security', 'policy', 'items', ajeno, '42501']) {
    expect(pantalla, `el navegador enseñó "${rastro}", que viene del cuerpo de PostgREST`)
      .not.toContain(rastro)
  }
  await b.ctx.close()
})

test('DoD 7: un guardado fallido no se lleva lo tecleado', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av5')
  const gid = await grupoCon(page, 'Offline')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'original', created_by: dueno.user_id })
  await page.reload(); await page.waitForLoadState('networkidle')

  const campo = page.getByTestId('item').first().getByLabel('Nombre')
  await campo.fill('lo que escribi')
  await ctx.setOffline(true)
  await campo.blur()
  await expect(page.getByTestId('notice')).toContainText(/conexión/i)
  await expect(campo, 'el aviso invita a reintentar y lo tecleado ya se había perdido')
    .toHaveValue('lo que escribi')
  await ctx.setOffline(false)
  await ctx.close()
})

test('DoD 12 y 13: dos personas añaden el mismo producto a la vez', async ({ browser }) => {
  const a = await entrar(browser, 'av6')
  const gid = await grupoCon(a.page, 'Duplicados')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'Cebolla', quantity: '1', created_by: dueno.user_id })
  await a.page.reload(); await a.page.waitForLoadState('networkidle')

  await a.page.getByTestId('item-name').fill('cebolla')
  await a.page.getByTestId('item-qty').fill('2')
  await a.page.getByTestId('add-item').click()

  await expect(a.page.getByTestId('notice')).toContainText(/ya está en la lista/i)
  /**
   * AE9 / DoD 134 — Éste es un `23505` **de verdad**, no un cuerpo fabricado, así
   * que la respuesta trae `details` — medido contra la base:
   * `Key (group_id, translate(…))=(<uuid>, cebolla) already exists`. Ese campo es
   * peor que `message`: lleva el UUID del grupo y el producto que escribió otra
   * persona. Ninguna guarda de navegador lo miraba porque el único e2e del caso
   * sembraba el cuerpo sin él.
   */
  const enPantalla = await a.page.evaluate(() => document.body.innerText)
  for (const rastro of [gid, 'already exists', 'Key (', 'translate(', 'items_nombre_unico']) {
    expect(enPantalla, `el navegador enseñó "${rastro}", que viene de details`)
      .not.toContain(rastro)
  }
  const { count } = await admin.from('items').select('*', { count: 'exact', head: true })
    .eq('group_id', gid).is('deleted_at', null)
  expect(count, 'la base dejó entrar el duplicado').toBe(1)
  await expect(a.page.getByLabel('Cantidad de Cebolla'), 'el foco no fue a la que ya estaba')
    .toBeFocused()
  await expect(a.page.getByLabel('Cantidad de Cebolla'), 'se pisó la cantidad de otra persona')
    .toHaveValue('1')
  await a.ctx.close()
})

test('DoD 14: la cantidad de un ítem de la lista se edita y se guarda', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av7')
  const gid = await grupoCon(page, 'Cantidad')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'pan', quantity: '2', created_by: dueno.user_id })
  await page.reload(); await page.waitForLoadState('networkidle')

  const cant = page.getByLabel('Cantidad de pan')
  await cant.fill('3 barras')
  await cant.blur()
  await expect.poll(async () => (await admin.from('items').select('quantity')
    .eq('group_id', gid).is('deleted_at', null).single()).data?.quantity).toBe('3 barras')
  await ctx.close()
})

test('DoD 15: el botón de añadir mide al menos 44x44', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av8')
  await grupoCon(page, 'Pulgar')
  const caja = await page.getByTestId('add-item').boundingBox()
  expect(Math.round(caja!.width), 'medido 41 en el QA').toBeGreaterThanOrEqual(44)
  expect(Math.round(caja!.height)).toBeGreaterThanOrEqual(44)
  await ctx.close()
})

/**
 * DoD 8 — El QA lo midió en el navegador: la fila desaparecía bajo el cursor y
 * lo tecleado se iba con ella, sin decir nada. El mensaje que lo explica ya
 * existía; lo que no había era un camino que lo disparara, porque el componente
 * se desmontaba antes de que `confirmar` llegara a ejecutarse.
 */
test('DoD 8: editar una fila que otro borra a la vez avisa y no pierde el texto', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'av9')
  const gid = await grupoCon(page, 'Carrera')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  const { data: fila } = await admin.from('items')
    .insert({ group_id: gid, name: 'victima', created_by: dueno.user_id }).select('id').single()
  await page.reload(); await page.waitForLoadState('networkidle')

  const campo = page.getByTestId('item').first().getByLabel('Nombre')
  await campo.click()
  await campo.fill('victima editada')
  // Otra sesión la borra mientras el campo sigue abierto.
  await admin.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', fila!.id)

  await expect(page.getByTestId('notice'), 'la fila se fue en silencio con la edición dentro')
    .toContainText(/quitó de la lista/i)
  await expect(campo, 'lo tecleado desapareció con la fila').toHaveValue('victima editada')
  await ctx.close()
})

/**
 * S6 / DoD 23 — El test anterior usaba UN contexto y sembraba la fila previa con
 * la clave de servicio, en secuencia: no había carrera. Aquí hay dos navegadores
 * reales pulsando a la vez, que es lo que el requisito nombra.
 */
test('DoD 23: dos navegadores añaden el mismo producto a la vez', async ({ browser }) => {
  const a = await entrar(browser, 'car1')
  const gid = await grupoCon(a.page, 'Carrera real')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  // El link se genera por la interfaz del dueño: `create_invite` comprueba
  // `auth.uid()`, y la clave de servicio no tiene ninguna.
  await a.page.getByTestId('create-invite').click()
  const enlace = await a.page.getByTestId('invite-link').inputValue()
  const tk = enlace.split('/invite/')[1]

  const b = await entrar(browser, 'car2')
  await b.page.goto(`/invite/${tk}`)
  await b.page.waitForLoadState('networkidle')
  const miembro = (await admin.from('group_members').select('user_id')
    .eq('group_id', gid).neq('user_id', dueno.user_id).single()).data!
  await admin.from('group_members').update({ status: 'active' })
    .eq('group_id', gid).eq('user_id', miembro.user_id)

  await a.page.goto(`/g/${gid}`); await a.page.waitForLoadState('networkidle')
  await b.page.goto(`/g/${gid}`); await b.page.waitForLoadState('networkidle')
  await a.page.getByTestId('item-name').fill('cebolla')
  await b.page.getByTestId('item-name').fill('Cebolla')

  await Promise.all([
    a.page.getByTestId('add-item').click(),
    b.page.getByTestId('add-item').click(),
  ])
  await a.page.waitForTimeout(2500)

  const { count } = await admin.from('items').select('*', { count: 'exact', head: true })
    .eq('group_id', gid).is('deleted_at', null)
  expect(count, 'la carrera dejó dos filas: la invariante no la impone el almacén').toBe(1)

  /**
   * T6/T10 — Antes esto afirmaba "hay UN aviso", que pasaría igual con "No hay
   * conexión" y también si alguien reintrodujera el `check-then-act` en el
   * cliente que la constitución veta. Ahora se afirma el texto **y el foco**: el
   * foco sólo puede caer ahí si la relectura de S11 existe, porque el perdedor no
   * tiene todavía la fila del otro.
   */
  const perdedor = (await a.page.getByTestId('notice').count()) ? a.page : b.page
  const ganador = perdedor === a.page ? b.page : a.page
  await expect(perdedor.getByTestId('notice')).toContainText(/ya está en la lista/i)
  await expect(ganador.getByTestId('notice')).toHaveCount(0)
  const cantidad = perdedor.getByLabel(/^Cantidad de /)
  await expect(cantidad, 'sin la relectura, el perdedor no tiene la fila y no hay foco')
    .toBeFocused()
  await a.ctx.close(); await b.ctx.close()
})

/** S2 / DoD 18 — la regresión, en la capa que el requisito nombra. */
test('DoD 18: editar nombre y cantidad de la misma fila conserva las dos', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'dos')
  const gid = await grupoCon(page, 'DosCampos')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'pan', quantity: '1', created_by: dueno.user_id })
  await page.reload(); await page.waitForLoadState('networkidle')

  await page.getByTestId('item').first().getByLabel('Nombre').fill('pan integral')
  await page.getByLabel('Cantidad de pan').fill('3 barras')
  await page.getByTestId('item').first().getByLabel('Nombre').blur()
  await expect.poll(async () => (await admin.from('items').select('name')
    .eq('group_id', gid).is('deleted_at', null).single()).data?.name).toBe('pan integral')
  await expect(page.getByLabel('Cantidad de pan integral'),
    'la cantidad recién tecleada se perdió al confirmar el nombre').toHaveValue('3 barras')
  await ctx.close()
})

/** S7 / DoD 24 — no dejar en pantalla una fila que ya no existe. */
test('DoD 24: la fila borrada desaparece al soltar el campo', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'gone')
  const gid = await grupoCon(page, 'Gone')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  const { data: fila } = await admin.from('items')
    .insert({ group_id: gid, name: 'victima', created_by: dueno.user_id }).select('id').single()
  await page.reload(); await page.waitForLoadState('networkidle')

  const campo = page.getByTestId('item').first().getByLabel('Nombre')
  await campo.click(); await campo.fill('editada')
  await admin.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', fila!.id)
  await expect(page.getByTestId('notice')).toContainText(/quitó de la lista/i)

  await campo.blur()
  await expect(page.getByTestId('item'),
    'la fila se quedó mostrando texto que no está guardado en ninguna parte').toHaveCount(0)
  await ctx.close()
})

/** S9 / DoD 26 — el fallo de sesión desde una acción de servidor también ofrece la salida. */
test('DoD 26: sin sesión, crear un grupo ofrece volver a entrar', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'acc')
  await page.goto('/')
  await ctx.clearCookies()
  await page.getByTestId('group-name').fill('Sin sesion')
  await page.getByTestId('create-group').click()
  await expect(page.getByTestId('group-notice')).toBeVisible()
  await expect(page.getByTestId('group-notice')).toContainText(/sesión/i)
  await expect(page.getByTestId('volver-a-entrar'),
    'se le dice que caducó y no se le da manera de volver').toBeVisible()
  await ctx.close()
})

/** T1 / DoD 29 — la fila ida se retira por CUALQUIER salida, no sólo por una. */
test('DoD 29: soltar sin cambiar nada también retira la fila que otro borró', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'ida')
  const gid = await grupoCon(page, 'Ida')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  const { data: fila } = await admin.from('items')
    .insert({ group_id: gid, name: 'victima', created_by: dueno.user_id }).select('id').single()
  await page.reload(); await page.waitForLoadState('networkidle')

  const campo = page.getByTestId('item').first().getByLabel('Nombre')
  await campo.click(); await campo.fill('editada')
  await admin.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', fila!.id)
  await expect(page.getByTestId('notice')).toContainText(/quitó de la lista/i)

  // El usuario se arrepiente y deja el texto ORIGINAL: la salida que no pasaba
  // por la rama de "0 filas afectadas".
  await campo.fill('victima')
  await campo.blur()
  await expect(page.getByTestId('item'),
    'la fila se quedó colgada: 1 en pantalla, 0 vivas en la base').toHaveCount(0)
  await ctx.close()
})

/**
 * T7 / DoD 39 — el botón no se queda esperando a la consulta de sesión.
 *
 * AF2 — Éste sí siembra la respuesta, y a propósito: lo que mide es el **tiempo**
 * con la consulta de sesión colgada, y colgarla exige interceptar. Lo que no
 * puede es medir el contenido, y no lo hace.
 */
test('DoD 39: tras un 42501 el botón de añadir vuelve enseguida', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'boton')
  await grupoCon(page, 'Boton')
  await page.route(/\/rest\/v1\/items/, async (ruta) => {
    if (ruta.request().method() !== 'POST') return ruta.continue()
    await ruta.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
      code: '42501', message: 'new row violates row-level security policy for table "items"' }) })
  })
  // La consulta de sesión se cuelga: el aviso y el botón no pueden depender de ella.
  await page.route(/\/auth\/v1\/(user|token)/, () => {})

  await page.getByTestId('item-name').fill('pan')
  await page.getByTestId('add-item').click()
  await expect(page.getByTestId('notice')).toBeVisible({ timeout: 3_000 })
  await expect(page.getByTestId('add-item'), 'el botón quedó bloqueado esperando a la sesión')
    .toBeEnabled({ timeout: 3_000 })
  await ctx.close()
})

/** T9 / DoD 41 — salir del grupo no puede tumbar la pantalla. */
test('DoD 41: un fallo al salir del grupo se pinta, no revienta', async ({ browser }) => {
  const a = await entrar(browser, 'sale1')
  const gid = await grupoCon(a.page, 'Salida')
  await a.page.getByTestId('create-invite').click()
  const tk = (await a.page.getByTestId('invite-link').inputValue()).split('/invite/')[1]

  const b = await entrar(browser, 'sale2')
  await b.page.goto(`/invite/${tk}`); await b.page.waitForLoadState('networkidle')
  const miembro = (await admin.from('group_members').select('user_id')
    .eq('group_id', gid).eq('status', 'pending').single()).data!
  await admin.from('group_members').update({ status: 'active' })
    .eq('group_id', gid).eq('user_id', miembro.user_id)
  await b.page.goto(`/g/${gid}`); await b.page.waitForLoadState('networkidle')

  // Se le retira el acceso justo antes de pulsar: la acción fallará.
  await admin.from('group_members').update({ status: 'removed' })
    .eq('group_id', gid).eq('user_id', miembro.user_id)
  await b.page.getByTestId('leave').click()

  /**
   * U7 — Antes esto sólo afirmaba que no salía la pantalla de error de Next, y
   * restaurar el `throw` lo dejaba verde: el test no podía fallar. Ahora exige el
   * aviso, que es lo que el requisito promete.
   */
  await expect(b.page.getByTestId('notice')).toBeVisible()
  await expect(b.page.getByTestId('notice')).toContainText(/acceso a este grupo|sesión/i)
  await expect(b.page.locator('body')).not.toContainText(/Application error|Unhandled Runtime/i)
  await a.ctx.close(); await b.ctx.close()
})

/** U1/U2 / DoD 42 — la fila colgada, por el camino que la revisión midió 3 de 3. */
test('DoD 42: fallo en A, otro borra A, tecleas en B: A desaparece y B conserva', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'colg')
  const gid = await grupoCon(page, 'Colgada')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  const { data: a } = await admin.from('items')
    .insert({ group_id: gid, name: 'uno', created_by: dueno.user_id }).select('id').single()
  await admin.from('items').insert({ group_id: gid, name: 'dos', created_by: dueno.user_id })
  await page.reload(); await page.waitForLoadState('networkidle')

  const filas = page.getByTestId('item')
  const campoA = filas.nth(0).getByLabel('Nombre')
  const campoB = filas.nth(1).getByLabel('Nombre')

  // 1) escritura de A que falla
  await page.route(/\/rest\/v1\/items/, async (ruta) => {
    if (ruta.request().method() !== 'PATCH') return ruta.continue()
    await ruta.abort('failed')
  })
  await campoA.fill('uno editado')
  await campoA.blur()
  await expect(page.getByTestId('notice')).toContainText(/conexión/i)
  await page.unroute(/\/rest\/v1\/items/)

  // 2) otro borra A
  await admin.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', a!.id)
  await expect(page.getByTestId('notice')).toContainText(/quitó de la lista/i)

  // 3) el usuario se va a teclear a B
  await campoB.fill('dos editado')
  await campoA.blur()

  await expect(page.getByTestId('item'), 'A se quedó colgada: en pantalla pero no en la base')
    .toHaveCount(1)
  await expect(page.getByTestId('item').first().getByLabel('Nombre'),
    'el borrador de B se perdió al cambiar de fila').toHaveValue('dos editado')
  await ctx.close()
})

/**
 * V1 / DoD 53 — Con el canal degradado —estado que la app detecta y anuncia— una
 * edición que va bien se revertía en pantalla: la vista soltaba el borrador y se
 * quedaba esperando a que el canal trajera el cambio. Un éxito pintado como
 * fallo, y justo en el camino de mala cobertura para el que existe esta app.
 */
test('DoD 53: con el canal caído, una edición correcta se queda', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'degr')
  const gid = await grupoCon(page, 'Degradado')
  const dueno = (await admin.from('group_members').select('user_id').eq('group_id', gid).single()).data!
  await admin.from('items').insert({ group_id: gid, name: 'pan', created_by: dueno.user_id })

  let bloqueado = false
  await page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
    if (bloqueado) { ws.close(); return }
    ws.connectToServer()
  })
  await page.goto(`/g/${gid}`); await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('pan')

  bloqueado = true
  await page.reload(); await page.waitForLoadState('networkidle')

  const campo = page.getByTestId('item').first().getByLabel('Nombre')
  await campo.fill('pan integral')
  await campo.blur()

  await expect.poll(async () => (await admin.from('items').select('name')
    .eq('group_id', gid).is('deleted_at', null).single()).data?.name).toBe('pan integral')
  await expect(campo, 'la edición fue bien y la pantalla la revirtió').toHaveValue('pan integral')
  await ctx.close()
})

/** V7 / DoD 60 — el enlace de volver a entrar no puede perder el destino. */
test('DoD 60: volver a entrar conserva el grupo que estabas mirando', async ({ browser }) => {
  const { ctx, page } = await entrar(browser, 'dest')
  const gid = await grupoCon(page, 'Destino')
  const cookies = await ctx.cookies()
  const sesion = cookies.filter(c => c.name.startsWith(CLAVE_COOKIE))
  await ctx.clearCookies()
  await ctx.addCookies(sesion.map(c => ({ ...c, value: 'base64-' + Buffer.from(
    JSON.stringify({ access_token: 'no.es.un.jwt', refresh_token: 'x', expires_at: 1 })).toString('base64') })))
  await page.getByTestId('item-name').fill('pan')
  await page.getByTestId('add-item').click()
  await expect(page.getByTestId('volver-a-entrar')).toBeVisible()
  const href = await page.getByTestId('volver-a-entrar').getAttribute('href')
  expect(href, 'sin `next` el usuario vuelve a entrar y aterriza lejos de su grupo')
    .toContain(encodeURIComponent(`/g/${gid}`))
  await ctx.close()
})
