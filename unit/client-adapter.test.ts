import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * T2 / DoD 38 — El cliente de navegador tuvo un adaptador de cookies escrito a
 * mano, y produjo dos defectos de producción: un 500 que quemaba el código de
 * sesión al partir pares suplentes, y un lector que lanzaba con un `%` suelto en
 * una cookie ajena. La spec base ya había declarado que ese sitio es donde un
 * error se paga caro.
 *
 * Esta guarda impide que vuelva sin que nadie lo note.
 */
const FUENTE = readFileSync('lib/supabase/client.ts', 'utf8')

describe('T2 el cliente de navegador usa el adaptador de la librería', () => {
  it.each([
    [/cookies\s*:\s*\{/, 'un adaptador en línea'],
    [/cookies\s*:\s*[A-Za-z_$]/, 'un adaptador por identificador'],
    [/storage\s*:\s*/, 'un almacén de sesión propio'],
  ])('no define %s (%s)', (patron) => {
    expect(FUENTE, 'volvió el adaptador propio sobre el almacén de sesión').not.toMatch(patron)
  })

  it('no manipula document.cookie a mano', () => {
    expect(FUENTE).not.toContain('document.cookie')
  })

  // Sonda (§E.2): sin un caso que deba detectarse, esto no distingue
  // "comprueba" de "acepta cualquier fichero".
  it.each([
    ['createBrowserClient(u, k, { cookies: { getAll, setAll } })', /cookies\s*:\s*\{/],
    ['createBrowserClient(u, k, { cookies: adaptador })', /cookies\s*:\s*[A-Za-z_$]/],
    ['createBrowserClient(u, k, { auth: { storage: miAlmacen } })', /storage\s*:\s*/],
  ])('la guarda caza %s', (muestra, patron) => {
    expect(muestra).toMatch(patron)
  })
})
