import { test, expect, type WebSocketRoute } from '@playwright/test'
import { createUser, makeGroup, addActiveMember, signedInContext, api } from './fixtures'
import { LISTA_EN_VIVO, SIN_CONEXION_LISTA } from '../lib/errors'

/**
 * I6 (DoD 30) y I7 (DoD 31): el canal caído se anuncia, y al volver se recupera
 * lo que se perdió mientras tanto.
 *
 * V4 — Esto usaba `ctx.setOffline(true)` y esperaba a que el aviso apareciera
 * solo. Medido: **caía 1 de cada 3 pasadas de la suite** con `channel-degraded`
 * sin aparecer en 30 s, y en aislamiento pasaba siempre en 20,7 s. No era el
 * producto: cortar la red no cierra el socket ya abierto, así que la caída sólo
 * se nota cuando expira el latido (`heartbeatIntervalMs: 8_000` +
 * `timeout: 8_000`), y ese instante depende de cuánto faltaba para el siguiente
 * latido. Esperar a un reloj que no se controla es el defecto, no el síntoma.
 *
 * Ahora el socket se cierra a propósito y se impide que vuelva a abrirse. La
 * caída es real —el WebSocket muere de verdad, no se simula el estado de la
 * vista— y además es la capa que el requisito nombra (§E.1): lo que se cae es
 * el canal, no la red en abstracto.
 */
test('el canal caído se anuncia, y al volver se recupera lo perdido', async ({ browser }) => {
  const owner = await createUser('res-owner')
  const member = await createUser('res-member')
  const { groupId, client } = await makeGroup(owner)
  await addActiveMember(owner, groupId, member)
  await client.from('items').insert({ group_id: groupId, name: 'pan', created_by: owner.id })

  const ctx = await signedInContext(browser, member)
  const page = await ctx.newPage()

  let bloqueado = false
  const abiertos: WebSocketRoute[] = []
  await page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
    // W9 — el tipo sale de la librería: un renombrado de la API de Playwright
    // ahora es un error de `typecheck`, no un fallo en ejecución.
    // Mientras esté bloqueado, cada reintento del cliente muere al nacer: así el
    // estado degradado se sostiene en vez de parpadear.
    if (bloqueado) { ws.close(); return }
    ws.connectToServer()
    abiertos.push(ws)
  })

  try {
    await page.goto(`/g/${groupId}`)
    await expect(page.getByTestId('item').first().getByLabel('Nombre')).toHaveValue('pan')
    await expect(page.getByTestId('channel-live')).toHaveCount(1)
    // AI7 / DoD 176 — se afirma el TEXTO, no sólo el localizador: AH5 mudó estos
    // tres avisos al traductor y nada comprobaba que siguieran diciendo lo mismo.
    await expect(page.getByTestId('channel-live')).toHaveText(LISTA_EN_VIVO)

    // DoD 30 — sin señal, la lista se congela y el usuario cree que está al día.
    bloqueado = true
    for (const s of abiertos) s.close()
    await expect(page.getByTestId('channel-degraded')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('channel-degraded')).toHaveText(SIN_CONEXION_LISTA)

    // Mientras el canal está caído, otro miembro añade algo: ese evento no le
    // llega a nadie que no esté escuchando.
    const ownerApi = await api(owner)
    await ownerApi.from('items').insert({ group_id: groupId, name: 'leche', created_by: owner.id })

    // DoD 31 — al recuperar el canal se relee: sin `onResync`, ese ítem quedaría
    // perdido para siempre en esta sesión, y dos personas comprando divergirían
    // de forma permanente.
    bloqueado = false
    await expect(page.getByTestId('channel-live')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('item')).toHaveCount(2, { timeout: 30_000 })
  } finally {
    // V5 — el teardown guardaba la traza con el contexto todavía sin red y cada
    // petición agotaba su plazo: el fichero tardaba entre 6,4 y 16,3 min en
    // fallar. Un runtime check de media hora desincentiva la verificación que
    // el propio ciclo ordena.
    bloqueado = false
    await ctx.close()
  }
})
