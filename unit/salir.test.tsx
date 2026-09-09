// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, fireEvent } from '@testing-library/react'

/**
 * L2 / DoD 57 — El botón de salir, con el almacén roto de verdad.
 *
 * `lib/local` **no** se dobla aquí a propósito: lo que se prueba es la
 * composición, que es donde estaba el daño. `BotonSalir` espera a `olvidarTodo`
 * antes de cerrar sesión —tiene que hacerlo, si no la redirección se lleva la
 * página antes de que el borrado acabe—, así que un almacén que rechaza dejaba a
 * la persona pulsando «Salir» sin salir.
 */
const signOutAction = vi.fn()
vi.mock('@/app/actions', () => ({ signOutAction: () => signOutAction() }))

const { BotonSalir } = await import('@/app/BotonSalir')

beforeEach(() => { vi.clearAllMocks(); signOutAction.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('L2 salir funciona aunque el almacén no', () => {
  it.each([
    ['la apertura lanza', { open: () => { throw new Error('SecurityError') } }],
    ['no hay IndexedDB', undefined],
  ])('DoD 57: con %s, «Salir» cierra sesión igual', async (_n, idb) => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', idb)
    const { BotonSalir: Boton } = await import('@/app/BotonSalir')
    const r = render(<Boton usuario="u1" />)
    fireEvent.click(r.getByTestId('signout'))
    await waitFor(() => expect(signOutAction, 'se quedó colgado antes de cerrar sesión')
      .toHaveBeenCalled())
  })

  // La sonda: el botón existe y llama, para que lo de arriba no pase por vacío.
  it('la sonda: con el almacén sano también cierra', async () => {
    const r = render(<BotonSalir usuario="u1" />)
    fireEvent.click(r.getByTestId('signout'))
    await waitFor(() => expect(signOutAction).toHaveBeenCalled())
  })
})
