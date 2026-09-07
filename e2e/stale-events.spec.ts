import { test, expect, type Browser, type Page } from '@playwright/test'
import { createUser, makeGroup, makeInvite, signedInContext, api, admin } from './fixtures'

/**
 * U1 / DoD 39, 48 — El canal entrega, tras `SUBSCRIBED`, los cambios anteriores a
 * la suscripción que siguen en el slot de replicación. La vista actuaba sobre el
 * PRIMER evento en vez de sobre el último estado, así que un miembro que **es**
 * `active` recibía su propio `pending` viejo y se le echaba del grupo.
 *
 * V2 — La primera versión de este test esperaba 6 s a ciegas. La revisión lo
 * midió con U1 revertido: **verde 2 de 4 veces contra el defecto que nombra**.
 * Cuando el slot ya se había drenado antes de que la página se suscribiera, las
 * aserciones pasaban sobre una página a la que no había llegado nada. Un test
 * que caza el defecto la mitad de las veces no es evidencia (§E.3).
 *
 * Ahora el escenario tiene precondición **observable**: la vista expone cuántos
 * eventos sobre la propia fila ha recibido, y hasta que no llega al menos uno no
 * se afirma nada. Si no llega, se reintenta con un grupo nuevo; si no se
 * reproduce en ningún intento, el test **falla** diciendo que no pudo montar el
 * escenario, en vez de dar verde por no haber mirado.
 *
 * Capa (§E.1): el navegador, que es donde vive la vista que expulsaba.
 */

const INTENTOS = 8

/** Monta la transición completa ANTES de abrir la página: eso es lo que la deja en el slot. */
let par: { owner: Awaited<ReturnType<typeof createUser>>; miembro: Awaited<ReturnType<typeof createUser>> } | null = null

async function escenarioConEventoViejo(browser: Browser) {
  // W12 — se creaban dos usuarios por intento: hasta 16 por pasada, sin recoger.
  // Sólo el grupo necesita ser nuevo; el par de usuarios se reutiliza.
  par ??= { owner: await createUser('stale-owner'), miembro: await createUser('stale-member') }
  const { owner, miembro } = par
  const { groupId, client } = await makeGroup(owner)
  await client.from('items').insert({ group_id: groupId, name: 'pan', created_by: owner.id })

  const token = await makeInvite(owner, groupId)
  await (await api(miembro)).rpc('request_join', { p_token: token })
  await (await api(owner)).rpc('decide_member', {
    p_group_id: groupId, p_user_id: miembro.id, p_decision: 'active',
  })

  const ctx = await signedInContext(browser, miembro)
  const page = await ctx.newPage()

  /**
   * El contexto y la página se montan ANTES de sembrar. El slot se lee por
   * lotes: si la suscripción llega después del lote que contenía el `pending`,
   * ese evento ya no se reproduce y el escenario no se monta — medido, pasaba la
   * mitad de las veces, y ésa era justo la mitad en que el test daba verde sin
   * haber probado nada. Crear el navegador después de sembrar metía segundos en
   * medio; calentarlo antes deja la ventana en el `goto`.
   */
  await page.goto('/')

  /**
   * Se siembra el slot con varios cambios peligrosos justo antes de abrir el
   * grupo. Todos se completan antes del `goto`, así que cuando la vista consulte
   * la fuente leerá `active`: la verdad final es la misma, sólo que ahora hay
   * eventos viejos suficientes para que alguno se reproduzca.
   */
  for (let i = 0; i < 5; i++) {
    await admin.from('group_members').update({ status: 'pending' })
      .eq('group_id', groupId).eq('user_id', miembro.id)
    await admin.from('group_members').update({ status: 'active' })
      .eq('group_id', groupId).eq('user_id', miembro.id)
  }

  await page.goto(`/g/${groupId}`)
  return { ctx, page, groupId }
}

type Desenlace = 'hazard-entregado' | 'expulsado' | 'nada'

/**
 * Espera a uno de tres desenlaces. Distinguir "me echaron" de "no llegó nada" es
 * lo que separa un rojo con la causa correcta de un verde en vacío.
 */
async function esperarDesenlace(page: Page, groupId: string, msPlazo: number): Promise<Desenlace> {
  const limite = Date.now() + msPlazo
  while (Date.now() < limite) {
    if (new URL(page.url()).pathname !== `/g/${groupId}`) return 'expulsado'
    // W8 — sin plazo explícito esto hereda el del test (180 s): si la
    // navegación cae entre la comprobación de URL y esta lectura, el bucle se
    // cuelga y el fallo acaba nombrando un timeout en vez de la expulsión.
    const n = Number(await page.getByTestId('eventos-membresia-peligrosos')
      .getAttribute('data-n', { timeout: 1_000 }).catch(() => '0') ?? '0')
    if (n > 0) return 'hazard-entregado'
    await page.waitForTimeout(200)
  }
  return 'nada'
}

test('DoD 39/48: un pending anterior no expulsa a quien ya es miembro activo', async ({ browser }) => {
  test.setTimeout(180_000)

  for (let intento = 1; intento <= INTENTOS; intento++) {
    const { ctx, page, groupId } = await escenarioConEventoViejo(browser)

    // La lista carga en cualquier caso; lo que decide si el escenario vale es
    // que el evento viejo se haya entregado.
    await expect(page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('pan')

    const desenlace = await esperarDesenlace(page, groupId, 6_000)

    if (desenlace === 'expulsado') {
      await ctx.close()
      throw new Error(
        'un evento anterior expulsó a un miembro activo: la vista actuó sobre el evento ' +
        'en vez de confirmar contra la fuente (U1)',
      )
    }
    if (desenlace === 'nada') {
      // El slot se drenó antes de la suscripción: este intento no prueba nada y
      // NO se afirma sobre él. Se descarta y se monta otro.
      await ctx.close()
      continue
    }

    // A partir de aquí sí hay hazard entregado: lo que se afirme es evidencia.
    expect(new URL(page.url()).pathname, 'un evento anterior expulsó a un miembro activo')
      .toBe(`/g/${groupId}`)
    await expect(page.getByTestId('item'), 'se vació la lista de un miembro activo')
      .toHaveCount(1)

    // Y sigue siéndolo pasado un margen: la expulsión llegaba por un evento
    // posterior del slot, no necesariamente por el primero.
    await page.waitForTimeout(2_000)
    expect(new URL(page.url()).pathname).toBe(`/g/${groupId}`)
    await expect(page.getByTestId('item')).toHaveCount(1)

    await ctx.close()
    return
  }

  throw new Error(
    `no se pudo montar el escenario en ${INTENTOS} intentos: el evento anterior no llegó a entregarse. ` +
    'El test NO da verde sin haberlo visto — antes sí lo hacía, y por eso cazaba el defecto 2 de 4 veces.',
  )
})
