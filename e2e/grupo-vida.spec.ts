import { test, expect, type Browser } from '@playwright/test'
import { admin, createUser, makeGroup, addActiveMember, signedInContext, api } from './fixtures'

/**
 * Spec H — las filas que hablan de la interfaz, en la interfaz. Las que hablan de la base están en
 * `unit/grupo-vida.test.ts` y atacan la base con el token de cada usuario (§E.1).
 *
 * h9 y h10 necesitan **dos contextos de navegador reales y simultáneos**: la propiedad es que una
 * pestaña cambie sin que nadie la recargue, y dos corrutinas en un mismo contexto no la representan.
 */

test('h13: los mandos son sólo del owner, y transferir sólo si hay otro miembro', async ({ browser }) => {
  const owner = await createUser('hv13-o')
  const { groupId } = await makeGroup(owner)

  const ownerCtx = await signedInContext(browser, owner)
  const ownerPage = await ownerCtx.newPage()
  await ownerPage.goto(`/g/${groupId}`)

  // Con un solo miembro no hay a quién pasarle nada: la lista de miembros activos ajenos está vacía.
  await expect(ownerPage.getByTestId('transfer'),
    'ofreció transferir sin nadie a quien transferir').toHaveCount(0)
  await expect(ownerPage.getByTestId('delete-group'),
    'el owner no puede borrar su grupo').toHaveCount(1)

  // Con un segundo miembro activo, aparece.
  const otro = await createUser('hv13-m')
  await addActiveMember(owner, groupId, otro)
  await ownerPage.reload()
  await expect(ownerPage.getByTestId('transfer'),
    'con dos miembros sigue sin ofrecer la transferencia').toHaveCount(1)

  // Y para el miembro no existe ninguno de los dos.
  const otroCtx = await signedInContext(browser, otro)
  const otroPage = await otroCtx.newPage()
  await otroPage.goto(`/g/${groupId}`)
  await expect(otroPage.getByTestId('items'), 'el miembro no llegó a ver la lista').toBeVisible()
  await expect(otroPage.getByTestId('transfer'), 'un miembro puede transferir el grupo').toHaveCount(0)
  await expect(otroPage.getByTestId('delete-group'), 'un miembro puede borrar el grupo').toHaveCount(0)

  await ownerCtx.close(); await otroCtx.close()
})

/**
 * **h9 y h10 van en tests separados, y no es cosmética.** Estaban juntos, y medido: con la
 * transferencia convertida en no-op, Playwright paraba en la primera aserción de h10 y **h9 no
 * llegaba a correr nunca**. Dos filas del DoD donde una tapa a la otra son una fila y media.
 */
const montarDosPestanas = async (browser: Browser, etq: string) => {
  const owner = await createUser(`${etq}-o`)
  const { groupId } = await makeGroup(owner)
  const otro = await createUser(`${etq}-m`)
  await addActiveMember(owner, groupId, otro)

  const ownerCtx = await signedInContext(browser, owner)
  const ownerPage = await ownerCtx.newPage()
  await ownerPage.goto(`/g/${groupId}`)
  await expect(ownerPage.getByTestId('channel-live'),
    'la pestaña del owner no llegó a suscribirse: el escenario no existe').toHaveCount(1)

  const otroCtx = await signedInContext(browser, otro)
  const otroPage = await otroCtx.newPage()
  await otroPage.goto(`/g/${groupId}`)
  await expect(otroPage.getByTestId('channel-live'),
    'la pestaña del miembro no llegó a suscribirse').toHaveCount(1)
  await expect(otroPage.getByTestId('delete-group'),
    'el miembro ya veía mandos de owner antes de la transferencia').toHaveCount(0)

  await ownerPage.getByTestId('transfer').click()
  await ownerPage.getByTestId('confirm-transfer-yes').click()
  return { ownerPage, otroPage, cerrar: async () => { await ownerCtx.close(); await otroCtx.close() } }
}

test('h10: el viejo owner deja de ver sus mandos sin recargar', async ({ browser }) => {
  const { ownerPage, cerrar } = await montarDosPestanas(browser, 'hv10')
  await expect(ownerPage.getByTestId('delete-group'),
    'el viejo owner sigue viendo el mando de borrar tras transferir').toHaveCount(0)
  await expect(ownerPage.getByTestId('transfer'),
    'el viejo owner sigue pudiendo transferir').toHaveCount(0)
  await expect(ownerPage.getByTestId('leave'),
    'el viejo owner no pasó a ver la salida de un miembro normal').toHaveCount(1)
  await cerrar()
})

test('h9: el nuevo owner ve sus mandos sin recargar, en la otra pestaña', async ({ browser }) => {
  const { otroPage, cerrar } = await montarDosPestanas(browser, 'hv9')
  await expect(otroPage.getByTestId('delete-group'),
    'el nuevo owner no vio el mando de borrar sin recargar').toHaveCount(1)
  await expect(otroPage.getByTestId('create-invite'),
    'el nuevo owner no puede invitar').toHaveCount(1)
  await cerrar()
})

test('h7: tras borrar, el grupo desaparece de la portada y su ruta da 404', async ({ browser }) => {
  const owner = await createUser('hv7-o')
  const { groupId, client } = await makeGroup(owner, 'Grupo que se borra')
  // i1-R3 — **Con ítems.** La primera versión borraba un grupo vacío y luego afirmaba que sus ítems
  // seguían en la base: sobre cero filas, esa afirmación no puede fallar de ninguna manera.
  await client.from('items').insert([
    { group_id: groupId, name: 'Leche', created_by: owner.id },
    { group_id: groupId, name: 'Pan', created_by: owner.id },
  ])
  const otro = await createUser('hv7-m')
  await addActiveMember(owner, groupId, otro)

  const ownerCtx = await signedInContext(browser, owner)
  const ownerPage = await ownerCtx.newPage()
  await ownerPage.goto('/')
  await expect(ownerPage.getByTestId('groups').getByRole('link'),
    'el grupo no estaba en la portada: la precondición no se cumple').toHaveCount(1)

  await ownerPage.goto(`/g/${groupId}`)
  await ownerPage.getByTestId('delete-group').click()
  await ownerPage.getByTestId('confirm-delete-yes').click()

  // Quien borra navega por su cuenta: no espera un evento de realtime.
  await expect(ownerPage).toHaveURL(/\/$/)
  await expect(ownerPage.getByTestId('groups').getByRole('link'),
    'el grupo borrado sigue listado en la portada').toHaveCount(0)

  const res = await ownerPage.goto(`/g/${groupId}`)
  expect(res?.status(), 'la ruta del grupo borrado no da 404').toBe(404)

  // Y para el otro miembro tampoco existe.
  const otroCtx = await signedInContext(browser, otro)
  const otroPage = await otroCtx.newPage()
  const resOtro = await otroPage.goto(`/g/${groupId}`)
  expect(resOtro?.status(), 'un ex-miembro sigue alcanzando el grupo borrado').toBe(404)

  /**
   * i1-R3 — **Dos afirmaciones, porque son dos propiedades y la primera no puede probar la segunda.**
   *
   * La versión anterior tenía una sola línea: leer los ítems con el token del ex-miembro y exigir
   * `[]`. Medido por la revisión: eso da `[]` **tanto si las filas sobreviven como si se destruyen**,
   * porque lo que devuelve cero es RLS. Era la única línea de todo el ciclo que decía comprobar §B.3
   * —la decisión congelada más cara del proyecto— y no podía ponerse roja jamás.
   */
  // (a) El acceso se cierra: con RLS, un ex-miembro no ve nada.
  const cli = await api(owner)
  const { data } = await cli.from('items').select('id').eq('group_id', groupId)
  expect(data, 'un ex-miembro lee los ítems del grupo borrado').toEqual([])

  // (b) Y las filas **siguen ahí**: eso sólo lo puede afirmar quien se salta RLS. Un borrado físico
  // sobre `items` —tabla publicada en `supabase_realtime`— es hard fail de la constitución.
  const { data: reales } = await admin.from('items').select('id').eq('group_id', groupId)
  expect(reales, 'los ítems se borraron físicamente de una tabla publicada: §B.3').toHaveLength(2)

  await ownerCtx.close(); await otroCtx.close()
})
