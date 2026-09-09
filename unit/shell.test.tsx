// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { SIN_INSTANTANEA, SIN_RED_FUERA } from '@/lib/errors'

/**
 * K4/K5 — El shell, atacado donde vive. La mitad de navegador (DoD 49) prueba la
 * fuga con cookies de verdad; ésta prueba lo que el navegador no puede provocar a
 * mano: un almacén que **rechaza**.
 */
const leerUltimoUsuario = vi.fn()
const leerLista = vi.fn()
const haySesionLocal = vi.fn()

vi.mock('@/lib/local', () => ({
  leerUltimoUsuario: () => leerUltimoUsuario(),
  leerLista: (...a: unknown[]) => leerLista(...a),
}))
vi.mock('@/lib/sesionLocal', () => ({ haySesionLocal: () => haySesionLocal() }))

const SinConexion = (await import('@/app/sin-conexion/page')).default

const enGrupo = (id = '8f1f1f7a-0000-4000-8000-000000000000') =>
  window.history.replaceState({}, '', `/g/${id}`)

beforeEach(() => {
  vi.clearAllMocks()
  haySesionLocal.mockReturnValue(true)
  leerUltimoUsuario.mockResolvedValue('u1')
  leerLista.mockResolvedValue([{ id: 'i1', name: 'anchoas', quantity: null }])
  window.history.replaceState({}, '', '/')
})
afterEach(() => cleanup())

describe('K4 sin sesión en el dispositivo no se pinta la instantánea de nadie', () => {
  it('DoD 49 (módulo): sin cookie de sesión no se lee nada y no se pinta nada', async () => {
    haySesionLocal.mockReturnValue(false)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(leerLista, 'se leyó la instantánea sin sesión en el dispositivo').not.toHaveBeenCalled()
    expect(screen.queryByText('anchoas'), 'la lista del anterior, sin sesión ninguna').toBeNull()
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_INSTANTANEA)
  })

  // La sonda: si no pintara nunca, lo de arriba no probaría nada.
  it('DoD 50: con sesión, la instantánea del grupo sí se pinta', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByText('anchoas')).toBeTruthy())
  })
})

describe('K5 el shell termina de cargar aunque el almacén falle', () => {
  it.each([
    ['la marca de usuario', () => leerUltimoUsuario.mockRejectedValue(new Error('InvalidStateError'))],
    ['la instantánea', () => leerLista.mockRejectedValue(new Error('InvalidStateError'))],
  ])('DoD 52: si %s rechaza, se dice algo en vez de quedarse en blanco', async (_n, romper) => {
    romper()
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_INSTANTANEA)
  })

  it('y fuera de un grupo, con el almacén roto, tampoco habla de «este grupo»', async () => {
    leerUltimoUsuario.mockRejectedValue(new Error('InvalidStateError'))
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_RED_FUERA)
  })
})
