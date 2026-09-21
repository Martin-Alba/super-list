// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import type { Item } from '@/lib/items'
import { SESION, DUPLICADO, GONE, claseDe } from '@/lib/errors'

/**
 * R2, R5, R6, R8 — Los tres caminos de fallo se prueban por separado. Un solo
 * test de "sale un aviso" los daría por buenos con dos de los tres rotos, que es
 * exactamente el estado que encontró el QA.
 */
/**
 * AD2 — El doble devolvía `error` con el **texto crudo**, que es lo que
 * `lib/items.ts` ya no produce. Podría devolver la clase a mano, pero entonces
 * estos tests dejarían de ejercitar la clasificación y pasarían a afirmar sobre
 * una etiqueta que el propio test elige: la tautología de siempre.
 *
 * Así que el doble hace **lo mismo que el fichero real**: recibe el crudo y el
 * código, y llama a `claseDe`. El camino que va del error de Postgres al mensaje
 * en pantalla se sigue recorriendo entero.
 */
let respuesta: { error: string | null; code: string | null; data: unknown } =
  { error: null, code: null, data: 1 }
const replace = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: {} } } }) } }),
}))
let entregarItem: (row: Item) => void = () => {}
vi.mock('@/lib/useGroupChannel', () => ({
  useGroupChannel: (_id: string, h: { onItem?: (r: Item) => void }) => {
    entregarItem = (row) => h.onItem?.(row)
    return 'live'
  },
}))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace }) }))
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: vi.fn(async () => ({ data: [], clase: null, code: null })),
  addItem: vi.fn(async () => comoElReal()),
  updateItem: vi.fn(async () => comoElReal()),
  softDeleteItem: vi.fn(async () => comoElReal()),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const item = (id: string, name: string, quantity: string | null = null): Item => ({
  id, group_id: 'g1', name, quantity, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, origen_id: null,
})

/** Lo mismo que hace `lib/items.ts`: clasifica donde el error nace. */
function comoElReal() {
  return {
    data: respuesta.data,
    clase: claseDe(respuesta.error ? { message: respuesta.error, code: respuesta.code } : null),
    code: respuesta.code,
  }
}

const montar = (items: Item[] = []) => render(
  <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={items}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }} />,
)

beforeEach(() => { vi.clearAllMocks(); respuesta = { error: null, code: null, data: 1 } })
afterEach(() => { cleanup() })

describe('R2 el corte en el cliente lo dice', () => {
  it.each(['     ', '\t\t', ''])('un producto %j avisa en vez de callar', async (texto) => {
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: texto } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    expect(screen.getByTestId('notice').textContent).toMatch(/nombre/i)
  })

  it('con un nombre válido no aparece aviso', async () => {
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })
})

describe('R4 la sesión caducada se nombra y ofrece la salida', () => {
  it('un PGRST301 al añadir dice sesión y da un enlace para volver a entrar', async () => {
    respuesta = { error: 'JWT expired', code: 'PGRST301', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(SESION))
    expect(screen.getByTestId('volver-a-entrar')).toBeTruthy()
  })

  it('un 42501 con sesión sigue diciendo que no hay acceso, y NO ofrece entrar', async () => {
    respuesta = { error: 'new row violates row-level security policy', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toMatch(/acceso a este grupo/i))
    expect(screen.queryByTestId('volver-a-entrar')).toBeNull()
  })
})

describe('R5 un guardado fallido no se lleva lo escrito', () => {
  it('el campo conserva el texto del usuario tras fallar', async () => {
    montar([item('i1', 'original')])
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    // R1 — sin código y con la red del navegador en pie, el fallo es del
    // servidor de datos, no de la conexión de quien escribe. Lo que R5 exige es
    // que el campo conserve lo tecleado, y eso no cambia.
    respuesta = { error: 'TypeError: failed to fetch', code: null, data: 0 }
    fireEvent.change(campo, { target: { value: 'lo que escribi' } })
    fireEvent.blur(campo)
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toMatch(/despertando/i))
    expect(campo.value, 'se perdió lo tecleado y el aviso invita a reintentar').toBe('lo que escribi')
  })

  it('cuando va bien, el campo suelta el borrador', async () => {
    montar([item('i1', 'original')])
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    fireEvent.change(campo, { target: { value: 'nuevo' } })
    fireEvent.blur(campo)
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })
})

describe('R7 el duplicado se avisa', () => {
  it('un 23505 al añadir dice que ya está en la lista', async () => {
    respuesta = { error: 'duplicate key value violates unique constraint', code: '23505', data: null }
    montar([item('i1', 'cebolla', '1')])
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'Cebolla' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(DUPLICADO))
  })

  it('y el foco cae en la cantidad del ítem que ya estaba', async () => {
    respuesta = { error: 'duplicate key value violates unique constraint', code: '23505', data: null }
    montar([item('i1', 'cebolla', '1')])
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'CEBOLLA' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Cantidad de cebolla')))
  })
})

describe('R8 la cantidad de un ítem se edita', () => {
  it('hay un campo de cantidad por fila y se guarda al soltarlo', async () => {
    const { updateItem } = await import('@/lib/items')
    montar([item('i1', 'pan', '2')])
    const cant = screen.getByLabelText('Cantidad de pan') as HTMLInputElement
    expect(cant.value).toBe('2')
    fireEvent.change(cant, { target: { value: '3 barras' } })
    fireEvent.blur(cant)
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith(
      expect.anything(), 'i1', { quantity: '3 barras' }))
  })

  it('vaciar la cantidad la borra, no la deja en blanco', async () => {
    const { updateItem } = await import('@/lib/items')
    montar([item('i1', 'pan', '2')])
    const cant = screen.getByLabelText('Cantidad de pan') as HTMLInputElement
    fireEvent.change(cant, { target: { value: '  ' } })
    fireEvent.blur(cant)
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith(
      expect.anything(), 'i1', { quantity: null }))
  })
})

describe('R9 el botón de añadir se puede pulsar', () => {
  it('declara ancho mínimo, no sólo alto', () => {
    const FUENTE = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')
    const boton = FUENTE.match(/data-testid="add-item"[\s\S]{0,220}/)?.[0] ?? ''
    expect(boton, 'medido 41x44: alto sí, ancho no').toMatch(/min-w-\[44px\]/)
  })
})

describe('R6 la fila que desaparece mientras la editas no se lleva tu texto', () => {
  it('avisa y conserva la fila si hay una edición en curso', async () => {
    montar([item('i1', 'victima')])
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    fireEvent.change(campo, { target: { value: 'victima editada' } })
    entregarItem({ ...item('i1', 'victima'), deleted_at: '2026-01-02T00:00:00Z' })
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(GONE))
    expect(screen.getByLabelText('Nombre'), 'la fila se desmontó con la edición dentro').toBeTruthy()
    expect((screen.getByLabelText('Nombre') as HTMLInputElement).value).toBe('victima editada')
  })

  it('sin edición en curso, la fila sí se retira y no se molesta al usuario', async () => {
    montar([item('i1', 'victima')])
    entregarItem({ ...item('i1', 'victima'), deleted_at: '2026-01-02T00:00:00Z' })
    await waitFor(() => expect(screen.queryByLabelText('Nombre')).toBeNull())
    expect(screen.queryByTestId('notice')).toBeNull()
  })
})

describe('R1 el traductor no puede dejar al usuario sin nada', () => {
  it('si no se puede consultar la sesión, el aviso sale igual', async () => {
    const mod = await import('@/lib/supabase/client')
    const espia = vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: async () => { throw new Error('sin red') } } } as never)
    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    espia.mockRestore()
  })
})

/**
 * S4 / DoD 21 — El aviso se pintaba DESPUÉS de preguntar por la sesión. Con el
 * servicio de auth colgado, medido en navegador, el usuario pasaba 30,6 s sin ver
 * nada. Un aviso que tarda medio minuto es un aviso que no existe, y además D.6
 * exige cota en toda llamada de red.
 */
describe('S4 el aviso no espera a la consulta de sesión', () => {
  it('con getSession colgado, el aviso aparece igual', async () => {
    const mod = await import('@/lib/supabase/client')
    const espia = vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: () => new Promise(() => {}) } } as never)
    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    // Sin el arreglo esto no aparece hasta que la consulta responda: nunca.
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy(), { timeout: 2000 })
    espia.mockRestore()
  })

  /**
   * DoD 1 y 2 — La puerta que abre el arreglo del sello (§E.4b). El test de la
   * puerta que se cierra —el afinado cancelado por una escritura correcta— se
   * conserva más abajo; éste es el camino nuevo, y es donde el defecto vive: con
   * la pantalla limpia, `limpiarAviso` no encuentra nada que limpiar y la cuenta
   * del sello sale bien por casualidad. Con un aviso ya puesto, la mueve.
   */
  it('con un aviso ya en pantalla, el segundo 42501 se sigue afinando', async () => {
    const mod = await import('@/lib/supabase/client')
    const espia = vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: async () => ({ data: { session: null } }) } } as never)
    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(SESION))

    // Y ahora el segundo, con el aviso del primero todavía puesto.
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'sal' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('notice').textContent,
      'el afinado se descartó: se lee «no tienes acceso» con la sesión muerta').toContain(SESION))
    expect(screen.queryByTestId('volver-a-entrar'),
      'y sin el enlace, que es el callejón que R4 cerró').toBeTruthy()
    espia.mockRestore()
  })

  it('y cuando responde que no hay sesión, el aviso se afina', async () => {
    const mod = await import('@/lib/supabase/client')
    const espia = vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: async () => ({ data: { session: null } }) } } as never)
    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(SESION))
    expect(screen.getByTestId('volver-a-entrar')).toBeTruthy()
    espia.mockRestore()
  })
})

/**
 * S2 / DoD 18 — El borrador guardaba un solo campo por fila: confirmar el nombre
 * soltaba el borrador entero y se perdía la cantidad recién tecleada. Es R5 al
 * revés, y en el camino feliz.
 */
describe('S2 editar nombre y cantidad de la misma fila conserva las dos', () => {
  it('no se pierde la cantidad al confirmar el nombre', async () => {
    const { updateItem } = await import('@/lib/items')
    montar([item('i1', 'pan', '1')])
    const nombre = screen.getByLabelText('Nombre') as HTMLInputElement
    const cant = screen.getByLabelText('Cantidad de pan') as HTMLInputElement

    fireEvent.change(nombre, { target: { value: 'pan integral' } })
    fireEvent.change(cant, { target: { value: '3 barras' } })
    fireEvent.blur(nombre)
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith(expect.anything(), 'i1', { name: 'pan integral' }))
    expect(cant.value, 'la cantidad recién tecleada se perdió al confirmar el nombre').toBe('3 barras')

    fireEvent.blur(cant)
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith(expect.anything(), 'i1', { quantity: '3 barras' }))
  })
})

/**
 * S7 / DoD 24 — R6 conserva la fila para no perder lo tecleado; lo que faltaba
 * era retirarla al soltar. Se quedaba en pantalla con el texto editado, como si
 * estuviera guardado y compartido, con 0 filas vivas en la base: fallar abierto.
 */
describe('S7 una fila que ya no existe no se queda como si estuviera guardada', () => {
  it('al soltar el campo, la fila desaparece', async () => {
    montar([item('i1', 'victima')])
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    fireEvent.change(campo, { target: { value: 'editada' } })
    entregarItem({ ...item('i1', 'victima'), deleted_at: '2026-01-02T00:00:00Z' })
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain(GONE))

    respuesta = { error: null, code: null, data: 0 }
    fireEvent.blur(campo)
    await waitFor(() => expect(screen.queryByLabelText('Nombre')).toBeNull())
  })
})

/**
 * T3 / DoD 31, 32 — Los dos caminos de pérdida de borrador que S2 dejó abiertos.
 * En móvil con red lenta, (b) es el caso normal: sigues escribiendo mientras la
 * escritura anterior está en vuelo.
 */
describe('T3 el borrador no se pierde por caminos laterales', () => {
  it('escribir en otra fila mientras vuela una escritura no borra su borrador', async () => {
    montar([item('i1', 'uno'), item('i2', 'dos')])
    const campos = screen.getAllByLabelText('Nombre') as HTMLInputElement[]
    let resolver: (v: unknown) => void = () => {}
    const { updateItem } = await import('@/lib/items')
    vi.mocked(updateItem).mockReturnValueOnce(new Promise(r => { resolver = r }) as never)

    fireEvent.change(campos[0], { target: { value: 'uno editado' } })
    fireEvent.blur(campos[0])
    fireEvent.change(campos[1], { target: { value: '5 kilos' } })
    resolver({ data: 0, clase: null, code: null })

    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    expect(campos[1].value, 'se borró el borrador de una fila que no era la suya').toBe('5 kilos')
  })

  it('seguir tecleando durante el await no revierte el campo', async () => {
    montar([item('i1', 'pan')])
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    let resolver: (v: unknown) => void = () => {}
    const { updateItem } = await import('@/lib/items')
    vi.mocked(updateItem).mockReturnValueOnce(new Promise(r => { resolver = r }) as never)

    fireEvent.change(campo, { target: { value: 'pan integral' } })
    fireEvent.blur(campo)
    fireEvent.change(campo, { target: { value: 'pan integral de centeno' } })
    resolver({ data: 1, clase: null, code: null })

    await waitFor(() => expect(updateItem).toHaveBeenCalled())
    expect(campo.value, 'el éxito de la escritura anterior tiró el texto nuevo')
      .toBe('pan integral de centeno')
  })
})

/**
 * T7 / DoD 37, 38 — El afinado llega tarde por definición. Sin sellarlo,
 * reaparecía sobre un aviso ya resuelto: medido, hasta 2 s después de una
 * escritura correcta.
 */
describe('T7 el afinado tardío no pisa lo que vino después', () => {
  it('no reaparece sobre una escritura posterior que fue bien', async () => {
    const mod = await import('@/lib/supabase/client')
    let soltar: (v: unknown) => void = () => {}
    vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: () => new Promise(r => { soltar = r }) } } as never)

    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar([item('i1', 'pan')])
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'leche' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())

    // Ahora una escritura que va bien limpia el aviso...
    respuesta = { error: null, code: null, data: 1 }
    const campo = screen.getByLabelText('Nombre') as HTMLInputElement
    fireEvent.change(campo, { target: { value: 'pan integral' } })
    fireEvent.blur(campo)
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())

    // ...y el afinado, que iba en vuelo, ya no le toca hablar.
    soltar({ data: { session: null } })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTestId('notice'), 'aviso zombi: reapareció sobre una escritura correcta')
      .toBeNull()
    vi.restoreAllMocks()
  })

  it('el botón de añadir no espera a la consulta de sesión', async () => {
    const mod = await import('@/lib/supabase/client')
    vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: () => new Promise(() => {}) } } as never)
    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(
      (screen.getByTestId('add-item') as HTMLButtonElement).disabled,
      'el botón quedó bloqueado esperando a la sesión').toBe(false))
    vi.restoreAllMocks()
  })
})

/** T2 / DoD 30 — el código del error de carga se usa de verdad, no se declara. */
describe('T2 el error de carga se clasifica por su código', () => {
  it('con PGRST301 ofrece volver a entrar', () => {
    render(
      <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={[]}
        members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
        profiles={[{ id: 'u1', display_name: 'Yo' }]}
        me={{ id: 'u1', role: 'owner' }}
        loadClase="sesion" />,
    )
    expect(screen.getByTestId('notice').textContent).toContain(SESION)
    expect(screen.getByTestId('volver-a-entrar')).toBeTruthy()
  })

  it('sin código, el mismo texto no ofrece nada', () => {
    render(
      <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={[]}
        members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
        profiles={[{ id: 'u1', display_name: 'Yo' }]}
        me={{ id: 'u1', role: 'owner' }}
        loadClase="generico" />,
    )
    expect(screen.queryByTestId('volver-a-entrar'),
      'forzar errorCode a null dejaba la suite entera en verde').toBeNull()
  })
})

/**
 * U1 / DoD 43, 44 — El borrador era UN objeto para toda la lista: cambiar de fila
 * lo mudaba, y con él se iba lo que R5 acababa de conservar. Ahora es un mapa por
 * fila, y eso cierra de raíz los dos defectos de producto que midió la revisión.
 */
describe('U1 el borrador de cada fila es suyo', () => {
  it('teclear en B no borra lo escrito en A', async () => {
    montar([item('i1', 'uno'), item('i2', 'dos')])
    const campos = screen.getAllByLabelText('Nombre') as HTMLInputElement[]
    fireEvent.change(campos[0], { target: { value: 'uno editado' } })
    fireEvent.change(campos[1], { target: { value: 'dos editado' } })
    expect(campos[0].value, 'cambiar de fila mudó el borrador entero').toBe('uno editado')
    expect(campos[1].value).toBe('dos editado')
  })

  it('tras un guardado fallido en A, teclear en B conserva las dos', async () => {
    montar([item('i1', 'uno'), item('i2', 'dos')])
    const campos = screen.getAllByLabelText('Nombre') as HTMLInputElement[]
    respuesta = { error: 'TypeError: failed to fetch', code: null, data: 0 }
    fireEvent.change(campos[0], { target: { value: 'uno editado' } })
    fireEvent.blur(campos[0])
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    fireEvent.change(campos[1], { target: { value: 'dos editado' } })
    expect(campos[0].value, 'R5 conservó el texto y cambiar de fila lo tiró').toBe('uno editado')
    expect(campos[1].value).toBe('dos editado')
  })
})

/** U3 / DoD 44 — el aviso zombi, por el camino de `onAdd` que T7 dejó sin sellar. */
describe('U3 el afinado no reaparece tras un alta correcta', () => {
  it('42501 → alta que va bien → el aviso no vuelve', async () => {
    const mod = await import('@/lib/supabase/client')
    let soltar: (v: unknown) => void = () => {}
    vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: () => new Promise(r => { soltar = r }) } } as never)

    respuesta = { error: 'permission denied for table items', code: '42501', data: null }
    montar()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())

    // El alta siguiente va bien y limpia el aviso...
    respuesta = { error: null, code: null, data: 1 }
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'leche' } })
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())

    // ...y el afinado en vuelo ya no le toca hablar.
    soltar({ data: { session: null } })
    await new Promise(r => setTimeout(r, 60))
    expect(screen.queryByTestId('notice'), 'aviso zombi por el camino de onAdd').toBeNull()
    vi.restoreAllMocks()
  })
})

/**
 * W1 / DoD 62 — V1 arregló "la edición correcta se revierte" y abrió el defecto
 * inverso: la fusión pisaba la fila incondicionalmente, así que el cambio de otro
 * miembro llegado por el canal durante el `await` se revertía al responder la
 * escritura. Es R-C en su forma más literal, y `mergeItems` ya tenía el criterio
 * escrito desde J6: gana la versión más reciente.
 */
describe('W1 la fusión cede ante lo más reciente', () => {
  it('renombrar no revierte la cantidad que otro acaba de cambiar', async () => {
    const { updateItem } = await import('@/lib/items')
    montar([item('i1', 'pan', '1')])
    const nombre = screen.getByLabelText('Nombre') as HTMLInputElement

    let resolver: (v: unknown) => void = () => {}
    vi.mocked(updateItem).mockReturnValueOnce(new Promise(r => { resolver = r }) as never)
    fireEvent.change(nombre, { target: { value: 'pan integral' } })
    fireEvent.blur(nombre)

    // Mientras vuela la escritura, otro miembro cambia la cantidad.
    entregarItem({ ...item('i1', 'pan', '3'), updated_at: '2026-01-02T00:00:00Z' })
    await waitFor(() => expect(
      (screen.getByLabelText('Cantidad de pan') as HTMLInputElement).value).toBe('3'))

    // La respuesta de MI escritura es más vieja: no puede pisarla.
    resolver({ data: { ...item('i1', 'pan integral', '1'), updated_at: '2026-01-01T00:00:00Z' },
      error: null, code: null })
    await new Promise(r => setTimeout(r, 40))
    expect((screen.getByLabelText('Cantidad de pan') as HTMLInputElement).value,
      'la respuesta de mi escritura revirtió el cambio correcto de otro').toBe('3')
  })
})

/**
 * Spec B / DoD 8 / R1 — La **tercera** cosa que `secuencia` sellaba, con guarda
 * propia porque es la que R1 puede colocar del lado equivocado sin que ningún
 * otro ítem lo note: el afinado por sesión sigue sellado por la generación de
 * **avisos**, no por la de recuperación.
 *
 * Vive aquí y no en `unit/drenado.test.tsx` por una razón medida: aquel arnés
 * mockea `createClient` sin `auth`, así que el afinado nunca llega a repintar y
 * el test **no podía fallar**. Lo encontró la pasada de mutación del ítem 10.
 */
describe('Spec B el afinado por sesión lo sella la generación de avisos', () => {
  it('DoD 8: limpiar un aviso cancela el afinado en vuelo', async () => {
    const mod = await import('@/lib/supabase/client')
    let responder!: (v: unknown) => void
    const espia = vi.spyOn(mod, 'createClient').mockReturnValue(
      { auth: { getSession: () => new Promise(r => { responder = r }) } } as never)
    try {
      // Un 42501 pinta «no tienes acceso» y lanza el afinado, que queda en vuelo.
      respuesta = { error: 'permission denied for table items', code: '42501', data: null }
      montar()
      fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
      fireEvent.click(screen.getByTestId('add-item'))
      await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())

      // Y antes de que conteste, una escritura correcta limpia el aviso.
      respuesta = { error: null, code: null, data: 1 }
      fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'sal' } })
      fireEvent.click(screen.getByTestId('add-item'))
      await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())

      // Ahora sí contesta, y dice que no hay sesión: ya no le toca hablar.
      await act(async () => { responder({ data: { session: null } }) })
      expect(screen.queryByTestId('notice')?.textContent ?? '',
        'el afinado reapareció sobre una escritura que fue bien').not.toContain(SESION)
    } finally { espia.mockRestore() }
  })
})
