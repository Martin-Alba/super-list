// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

/**
 * K6/K7 — Quién está dentro se apunta desde el navegador, y si no se puede
 * apuntar **no queda la marca del anterior**: un usuario nuevo delante con la
 * marca del anterior detrás es exactamente la fuga que K4 cierra por el otro
 * lado.
 */
const getSession = vi.fn()
const leerUltimoUsuario = vi.fn()
const guardarUltimoUsuario = vi.fn()
const olvidarUltimoUsuario = vi.fn()
const olvidarTodo = vi.fn()

const construido = vi.fn()
const haySesionLocal = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => { construido(); return { auth: { getSession } } },
}))
vi.mock('@/lib/sesionLocal', () => ({ haySesionLocal: () => haySesionLocal() }))
vi.mock('@/lib/local', () => ({
  leerUltimoUsuario: () => leerUltimoUsuario(),
  guardarUltimoUsuario: (...a: unknown[]) => guardarUltimoUsuario(...a),
  olvidarUltimoUsuario: () => olvidarUltimoUsuario(),
  olvidarTodo: (...a: unknown[]) => olvidarTodo(...a),
}))

const { RecordarUsuario } = await import('@/app/RecordarUsuario')

beforeEach(() => {
  vi.clearAllMocks()
  haySesionLocal.mockReturnValue(true)
  getSession.mockResolvedValue({ data: { session: { user: { id: 'u2' } } } })
  leerUltimoUsuario.mockResolvedValue(null)
  guardarUltimoUsuario.mockResolvedValue(true)
  olvidarUltimoUsuario.mockResolvedValue(true)
  olvidarTodo.mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe('K6 si no se puede apuntar quién está dentro, no queda marca de nadie', () => {
  it('DoD 53: una escritura rechazada borra la marca en vez de dejar la vieja', async () => {
    leerUltimoUsuario.mockResolvedValue('u1')
    guardarUltimoUsuario.mockResolvedValue(false)
    render(<RecordarUsuario />)
    await waitFor(() => expect(olvidarUltimoUsuario).toHaveBeenCalled())
  })

  // La sonda: si borrara siempre, el shell no pintaría nunca nada.
  it('y si la escritura entra, la marca se queda', async () => {
    render(<RecordarUsuario />)
    await waitFor(() => expect(guardarUltimoUsuario).toHaveBeenCalledWith('u2'))
    expect(olvidarUltimoUsuario, 'borró una marca que sí se había escrito').not.toHaveBeenCalled()
  })

  it('lo del anterior se borra antes de apuntar al nuevo', async () => {
    leerUltimoUsuario.mockResolvedValue('u1')
    render(<RecordarUsuario />)
    await waitFor(() => expect(guardarUltimoUsuario).toHaveBeenCalled())
    expect(olvidarTodo).toHaveBeenCalledWith('u1')
    expect(olvidarTodo.mock.invocationCallOrder[0])
      .toBeLessThan(guardarUltimoUsuario.mock.invocationCallOrder[0])
  })

  it('y sin sesión no se apunta a nadie', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    render(<RecordarUsuario />)
    await new Promise(r => setTimeout(r, 20))
    expect(guardarUltimoUsuario).not.toHaveBeenCalled()
    expect(olvidarTodo).not.toHaveBeenCalled()
  })
})

/**
 * L1 / DoD 55 — La marca del anterior se quita **antes** de borrar lo suyo.
 * `olvidarTodo` son N+2 viajes a disco, y durante ese rato la cookie del nuevo
 * convivía con la marca del viejo: el shell responde a «hay sesión», no a «de
 * quién», así que en esa ventana enseñaba la lista del anterior.
 */
describe('L1 cambiar de usuario no deja ventana', () => {
  it('DoD 55: la marca se quita antes de empezar a borrar', async () => {
    leerUltimoUsuario.mockResolvedValue('u1')
    render(<RecordarUsuario />)
    await waitFor(() => expect(olvidarTodo).toHaveBeenCalledWith('u1'))
    expect(olvidarUltimoUsuario.mock.invocationCallOrder[0],
      'la marca del anterior sobrevivió al borrado: hay ventana de lectura cruzada')
      .toBeLessThan(olvidarTodo.mock.invocationCallOrder[0])
  })

  // La sonda: sin cambio de usuario no se borra nada de nadie.
  it('y si es el mismo usuario, no se borra nada', async () => {
    leerUltimoUsuario.mockResolvedValue('u2')
    render(<RecordarUsuario />)
    await waitFor(() => expect(guardarUltimoUsuario).toHaveBeenCalledWith('u2'))
    expect(olvidarTodo).not.toHaveBeenCalled()
    expect(olvidarUltimoUsuario).not.toHaveBeenCalled()
  })
})

/**
 * L7 / DoD 63 — Construir el cliente arranca su temporizador de refresco: en la
 * pantalla sin red eso es un POST a `/auth/v1/token` desde la pantalla que existe
 * porque no hay red. La misma pregunta que hace el shell, por el mismo sitio.
 */
describe('L7 sin sesión en el dispositivo no se construye el cliente de auth', () => {
  it('DoD 63: sin cookie, ni cliente ni escrituras', async () => {
    haySesionLocal.mockReturnValue(false)
    render(<RecordarUsuario />)
    await new Promise(r => setTimeout(r, 20))
    expect(construido, 'se construyó el cliente de auth sin sesión que leer').not.toHaveBeenCalled()
    expect(guardarUltimoUsuario).not.toHaveBeenCalled()
  })

  it('la sonda: con cookie sí se construye', async () => {
    render(<RecordarUsuario />)
    await waitFor(() => expect(construido).toHaveBeenCalled())
  })
})
