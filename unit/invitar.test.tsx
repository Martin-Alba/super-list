// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { COPIADO, COPIAR_FALLO, COMPARTIR_FALLO } from '@/lib/errors'

/**
 * Spec J / J-R6..J-R9, j10–j14 — **El enlace de invitación se manda, no se lee.**
 *
 * El campo de sólo lectura obligaba a seleccionar a mano en un móvil, que es donde se usa
 * esto. En su lugar, uno de dos botones —compartir donde el sistema lo ofrece, copiar donde
 * no—, y una salida de texto para cuando las dos vías fallan.
 *
 * Se ataca **la vista**, que es la capa que los requisitos nombran: quién decide qué botón
 * se pinta, qué pasa al pulsarlo, y qué se dice y qué no. `navigator.share` no existe en
 * jsdom, así que se instala por prueba — y eso es fiel al mecanismo, porque el mecanismo
 * consiste precisamente en preguntarle al navegador qué sabe hacer.
 */

const createInviteAction = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: {} } } }) } }),
}))
vi.mock('@/lib/useGroupChannel', () => ({ useGroupChannel: () => 'live' }))
vi.mock('@/app/actions', () => ({
  createInviteAction: (...a: unknown[]) => createInviteAction(...a),
  decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
  transferGroupAction: vi.fn(), deleteGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: vi.fn(async () => ({ data: [], clase: null, code: null })),
  addItem: vi.fn(async () => ({ data: null, clase: null, code: null })),
  updateItem: vi.fn(async () => ({ data: null, clase: null, code: null })),
  softDeleteItem: vi.fn(async () => ({ data: 1, clase: null, code: null })),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const montar = () => render(
  <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={[]}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }} />,
)

const ENLACE = `${window.location.origin}/invite/tok-123`

/**
 * Lo que el navegador sabe hacer, dicho por prueba. `undefined` es «no existe», que es el
 * escritorio: es el caso que decide que se pinte Copiar, y montar el doble siempre disponible
 * dejaría j11 y j14 sin poder ocurrir nunca.
 */
function navegador(opciones: {
  share?: (d: ShareData) => Promise<void>
  canShare?: (d: ShareData) => boolean
  clipboard?: { writeText: (t: string) => Promise<void> }
}) {
  const nav = navigator as unknown as Record<string, unknown>
  for (const clave of ['share', 'canShare', 'clipboard'] as const) {
    const valor = opciones[clave]
    if (valor === undefined) delete nav[clave]
    else Object.defineProperty(nav, clave, { value: valor, configurable: true, writable: true })
  }
}

/** Genera el enlace, que es el gesto que existe antes de todo lo demás. */
async function generar() {
  createInviteAction.mockResolvedValue({ token: 'tok-123' })
  fireEvent.click(screen.getByTestId('create-invite'))
  await waitFor(() => expect(createInviteAction).toHaveBeenCalledWith('g1'))
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); navegador({}) })

describe('Spec J · el enlace de invitación se comparte', () => {
  it('j10: con compartir disponible, el botón llama a navigator.share con el enlace', async () => {
    const share = vi.fn(async () => {})
    navegador({ share, canShare: () => true })
    montar()
    await generar()
    const boton = await screen.findByTestId('share-invite')
    expect(screen.queryByTestId('copy-invite'), 'se pintaron los dos botones').toBeNull()
    fireEvent.click(boton)
    await waitFor(() => expect(share).toHaveBeenCalledWith({ url: ENLACE }))
  })

  it('j11: sin compartir disponible, se pinta Copiar y copia el enlace', async () => {
    const writeText = vi.fn(async () => {})
    navegador({ clipboard: { writeText } })
    montar()
    await generar()
    const boton = await screen.findByTestId('copy-invite')
    expect(screen.queryByTestId('share-invite'), 'se ofreció compartir donde no existe').toBeNull()
    fireEvent.click(boton)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ENLACE))
    // El borde escrito: al pulsarlo, confirma que copió.
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COPIADO))
  })

  /**
   * j11 bis — `canShare` manda sobre `share`. Un navegador puede tener `share` y contestar
   * que **no** puede compartir esta carga; ahí lo correcto es Copiar. Sin esta fila, la
   * expresión `canShare?.({url}) ?? !!share` podría reducirse a `!!share` sin que nada se
   * pusiera rojo, y el usuario se quedaría con un botón que no hace nada.
   */
  it('j11 bis: con share pero canShare diciendo que no, se pinta Copiar', async () => {
    navegador({ share: vi.fn(async () => {}), canShare: () => false, clipboard: { writeText: vi.fn(async () => {}) } })
    montar()
    await generar()
    expect(await screen.findByTestId('copy-invite')).toBeTruthy()
    expect(screen.queryByTestId('share-invite'), 'canShare dijo que no y se ofreció compartir').toBeNull()
  })

  it('j12: cancelar el menú (AbortError) no pinta aviso', async () => {
    const abort = Object.assign(new Error('Share canceled'), { name: 'AbortError' })
    navegador({ share: vi.fn(async () => { throw abort }), canShare: () => true })
    montar()
    await generar()
    fireEvent.click(await screen.findByTestId('share-invite'))
    // Se espera a que el rechazo se haya procesado, no sólo a que no haya aviso «todavía».
    await waitFor(() => expect(screen.queryByTestId('invite-text')).toBeNull())
    expect(screen.queryByTestId('notice'), 'cancelar el menú se anunció como un fallo').toBeNull()
  })

  /**
   * j13 — **La sonda de j12.** Sin ella, «no avisa nunca» pasaría por «no avisa al cancelar»:
   * un `catch` vacío cumpliría j12 entero y dejaría el fallo real en silencio.
   *
   * El nombre del error es lo que decide, **no su mensaje**: éste dice «abort» dentro del
   * texto a propósito, así que un filtro por `includes('abort')` callaría aquí y esta fila lo
   * caza. Es la forma construida de cumplir J-R8 al pie de la letra y fallar igual.
   */
  it('j13: un rechazo con otro name sí pinta aviso, aunque el mensaje diga «abort»', async () => {
    const otro = Object.assign(new Error('share aborted by policy'), { name: 'NotAllowedError' })
    navegador({ share: vi.fn(async () => { throw otro }), canShare: () => true })
    montar()
    await generar()
    fireEvent.click(await screen.findByTestId('share-invite'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COMPARTIR_FALLO))
    // Y el enlace queda recuperable: si compartir no funciona, sin esto no hay otra vía.
    expect(screen.getByTestId('invite-text').textContent).toBe(ENLACE)
  })

  it('j14: si copiar falla y compartir no está, el enlace sale como texto seleccionable', async () => {
    navegador({ clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    montar()
    await generar()
    fireEvent.click(await screen.findByTestId('copy-invite'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COPIAR_FALLO))
    const texto = screen.getByTestId('invite-text')
    expect(texto.textContent).toBe(ENLACE)
    // Pequeño y seleccionable, que es lo que la decisión 3 pide, y no el campo de vuelta.
    expect(texto.className, 'el enlace no es seleccionable de un gesto').toContain('select-all')
    expect(texto.tagName, 'volvió el campo que esta spec quita').not.toBe('INPUT')
  })

  it('j14 bis: sin portapapeles en el navegador, el camino es el mismo que si falla', async () => {
    // Contexto no seguro: `navigator.clipboard` no existe. Sin cubrirlo, un `try` que sólo
    // atrapa el rechazo dejaría una excepción suelta y el enlace irrecuperable.
    navegador({})
    montar()
    await generar()
    fireEvent.click(await screen.findByTestId('copy-invite'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COPIAR_FALLO))
    expect(screen.getByTestId('invite-text').textContent).toBe(ENLACE)
  })

  /**
   * i12 — **Del callejón se sale.** `enlaceALaVista` no volvía nunca a `false`, así que tras
   * un fallo de copiado el texto se quedaba pintado incluso cuando el siguiente intento
   * salía bien, bajo un «Enlace copiado.» que lo contradecía. La decisión 3 dice «sólo
   * aparece cuando lo hay».
   */
  it('i12: copiar bien después de fallar retira el enlace a la vista', async () => {
    const writeText = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('denied') })
      .mockImplementation(async () => {})
    navegador({ clipboard: { writeText } })
    montar()
    await generar()
    const boton = await screen.findByTestId('copy-invite')
    fireEvent.click(boton)
    await waitFor(() => expect(screen.getByTestId('invite-text')).toBeTruthy())
    fireEvent.click(boton)
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COPIADO))
    expect(screen.queryByTestId('invite-text'),
      'el enlace se quedó a la vista después de un copiado con éxito').toBeNull()
  })

  /**
   * k3 — **El gemelo de i12.** i1-R10 arregló «del callejón se sale» en copiar y no en
   * compartir, que es el camino del móvil, que es donde vive esta funcionalidad. Medido en
   * rojo por la revisión: compartir falla → sale el texto; se vuelve a pulsar y sale bien →
   * el texto se queda pintado, sin nada que lo contradiga.
   *
   * Desde i2-R7 los dos caminos pasan por el mismo manejador, así que esta fila y la de
   * copiar prueban **el mismo código** — y eso es exactamente lo que se quería: que la regla
   * sea estructural y no algo que haya que recordar dos veces.
   */
  it('k3: compartir bien después de fallar retira el enlace a la vista', async () => {
    const share = vi.fn()
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('no'), { name: 'NotAllowedError' })
      })
      .mockImplementation(async () => {})
    navegador({ share, canShare: () => true })
    montar()
    await generar()
    const boton = await screen.findByTestId('share-invite')
    fireEvent.click(boton)
    await waitFor(() => expect(screen.getByTestId('invite-text')).toBeTruthy())
    fireEvent.click(boton)
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('invite-text'),
      'el enlace se quedó a la vista después de compartir con éxito').toBeNull())
  })

  /**
   * Y la mitad que k3 podría romper sin querer: salir bien **no** puede empezar a anunciar
   * nada en el camino de compartir. Compartir es el gesto; el sistema ya da su propio acuse.
   */
  it('k3 bis: compartir con éxito no pinta aviso', async () => {
    navegador({ share: vi.fn(async () => {}), canShare: () => true })
    montar()
    await generar()
    fireEvent.click(await screen.findByTestId('share-invite'))
    await waitFor(() => expect(screen.queryByTestId('invite-text')).toBeNull())
    expect(screen.queryByTestId('notice'), 'compartir bien se anunció como si hiciera falta').toBeNull()
  })

  /**
   * m4 — **Cancelar no tiene NINGÚN efecto observable.** j12 sólo miraba que no apareciera un
   * aviso, y arrancaba con la pantalla limpia: con un aviso previo en pantalla, el
   * `limpiarAviso()` que corría antes de saber el desenlace **lo borraba**. El borde de J-R8
   * dice «nada: ni aviso, ni error, **ni cambio de estado**», y borrar algo que había es un
   * cambio de estado.
   */
  it('m4: cancelar no borra un aviso que ya estaba en pantalla', async () => {
    const abort = Object.assign(new Error('Share canceled'), { name: 'AbortError' })
    navegador({ share: vi.fn(async () => { throw abort }), canShare: () => true })
    montar()
    await generar()
    await screen.findByTestId('share-invite')
    /**
     * El aviso previo se crea **después** de generar el enlace, no antes: el handler de
     * «Generar» empieza con su propio `limpiarAviso()`, así que un aviso anterior a él lo
     * borra ese gesto y no el que esta fila mide. Es el orden el que hace la prueba honesta.
     */
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    const antes = screen.getByTestId('notice').textContent

    fireEvent.click(screen.getByTestId('share-invite'))
    await waitFor(() => expect(screen.queryByTestId('invite-text')).toBeNull())
    expect(screen.queryByTestId('notice')?.textContent,
      'cancelar la hoja de compartir se llevó por delante un aviso que no era suyo').toBe(antes)
  })

  /**
   * m5 — **Dos toques seguidos no anuncian como fallido un envío que sale bien.**
   *
   * Es el gesto normal en un móvil, no el raro: el segundo toque recibe `InvalidStateError`
   * —«share already in progress»—, y sin guarda de reentrada pintaba «No se ha podido
   * compartir» sobre un envío que la persona estaba a punto de completar.
   */
  it('m5: un doble toque en compartir no deja un aviso de fallo', async () => {
    let soltar!: () => void
    const primera = new Promise<void>(r => { soltar = r })
    const share = vi.fn()
      .mockImplementationOnce(() => primera)
      .mockImplementation(async () => {
        throw Object.assign(new Error('share already in progress'), { name: 'InvalidStateError' })
      })
    navegador({ share, canShare: () => true })
    montar()
    await generar()
    const boton = await screen.findByTestId('share-invite')

    fireEvent.click(boton)   // el primero se queda en vuelo
    fireEvent.click(boton)   // el pulgar, otra vez
    expect(share, 'el segundo toque llegó a llamar a compartir').toHaveBeenCalledTimes(1)

    await act(async () => { soltar() })
    await waitFor(() => expect(screen.queryByTestId('invite-text')).toBeNull())
    expect(screen.queryByTestId('notice'),
      'un envío que salió bien quedó anunciado como fallido').toBeNull()
  })

  it('j6 bis: el campo de sólo lectura ya no existe en ningún camino', async () => {
    navegador({ share: vi.fn(async () => {}), canShare: () => true })
    montar()
    await generar()
    await screen.findByTestId('share-invite')
    expect(screen.queryByTestId('invite-link'),
      'el campo grande sigue ahí: J-R6 no está hecho, sólo tapado').toBeNull()
  })

  it('el enlace no sale a la vista mientras no haga falta', async () => {
    // La sonda de j14: si el texto estuviera siempre, j14 pasaría sin que nada lo decidiera,
    // y sería el campo de sólo lectura con otro nombre.
    navegador({ clipboard: { writeText: vi.fn(async () => {}) } })
    montar()
    await generar()
    await screen.findByTestId('copy-invite')
    expect(screen.queryByTestId('invite-text'), 'el enlace se pinta sin que haya callejón').toBeNull()
    fireEvent.click(screen.getByTestId('copy-invite'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(COPIADO))
    expect(screen.queryByTestId('invite-text'), 'copiar salió bien y aun así se pintó el texto').toBeNull()
  })
})
