import { describe, it, expect } from 'vitest'
import { CANTIDAD_FUERA, claseDe, mensajeDe, refinarSinRed, TEXTO } from '../lib/errors'

/**
 * L5 / DoD 67 — `failed to fetch` es el texto del navegador; Node, en servidor,
 * produce `TypeError: fetch failed`. Sin las dos formas el fallo real del
 * servidor caia al mensaje generico, que no dice al usuario que reintentar.
 */
describe('L5 la traduccion de errores cubre el fallo de red del servidor', () => {
  /**
   * R1 — Estas cinco llegaban **sin código**, y antes se clasificaban leyendo su
   * texto. Ahora sin código decide la red: si está caída, es de la conexión; si
   * está bien, no contestó el servidor. Se afirma con la red caída, que es cuando
   * «no hay conexión» es cierto.
   */
  it.each([
    'TypeError: fetch failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'The operation was aborted',
    'signal timed out',
  ])('%s sin red se traduce como problema de conexion', (raw) => {
    expect(mensajeDe(refinarSinRed(claseDe({ message: raw }), false))).toContain('conexión')
  })

  it.each([
    'TypeError: fetch failed',
    'The operation was aborted',
  ])('%s con la red bien no culpa a la conexion', (raw) => {
    expect(mensajeDe(refinarSinRed(claseDe({ message: raw }), true))).not.toContain('conexión')
  })

  // Con su código real: medido, toda denegación de RLS llega con `42501`.
  it('una denegacion de RLS no se confunde con un problema de red', () => {
    const msg = mensajeDe(claseDe({
      code: '42501', message: 'new row violates row-level security policy for table "items"',
    }))
    expect(msg).not.toContain('conexión')
    expect(msg).toContain('acceso')
  })

  it('nunca devuelve el texto crudo', () => {
    const crudo = 'new row violates row-level security policy for table "items"'
    const e = { code: '42501', message: crudo }
    expect(mensajeDe(claseDe(e))).not.toContain('row-level')
    expect(mensajeDe(claseDe(e))).not.toContain('items')
  })
})

/**
 * Spec C / R4 — El banner deja de ser incondicional.
 *
 * Medido el 2026-09-13 en el navegador: `SIN_RED_SOLO_LECTURA` se pintaba
 * siempre, así que en la portada prometía «esto es lo último que vimos» sin haber
 * visto nada, y prometía «cuando vuelva la red podrás apuntar» en una pantalla
 * que no dejaba apuntar y que además no se enteraba de que la red volvía.
 *
 * Se prueba la función y no el componente porque el requisito es «qué dice según
 * el estado», y ese estado son tres booleanos (§E.1). Que se pinte lo que
 * devuelve lo comprueba la vista.
 *
 * Qué lo pone rojo (§E.3): volver a un texto único.
 */
describe('Spec C · el banner dice lo que esta pantalla hace', () => {
  it('dentro de un grupo con copia: nombra la copia y ofrece apuntar', async () => {
    const { bannerSinRed } = await import('@/lib/errors')
    const t = bannerSinRed({ enUnGrupo: true, haySesion: true, hayCopia: true })
    expect(t).toMatch(/último que vimos/i)
    expect(t, 'no ofrece apuntar, que es lo que ahora sí se puede').toMatch(/apuntar/i)
  })

  it('dentro de un grupo sin copia: NO promete memoria, pero sí ofrece apuntar', async () => {
    const { bannerSinRed } = await import('@/lib/errors')
    const t = bannerSinRed({ enUnGrupo: true, haySesion: true, hayCopia: false })
    expect(t, 'promete una copia que no hay').not.toMatch(/último que vimos/i)
    expect(t).toMatch(/apuntar/i)
  })

  it('fuera de un grupo: ni memoria ni apuntar, porque no hay dónde', async () => {
    const { bannerSinRed } = await import('@/lib/errors')
    const t = bannerSinRed({ enUnGrupo: false, haySesion: true, hayCopia: false })
    expect(t, 'promete una copia que no hay').not.toMatch(/último que vimos/i)
    expect(t, 'ofrece apuntar sin grupo al que apuntar').not.toMatch(/apuntar/i)
  })

  it('sin sesión en el dispositivo: tampoco ofrece apuntar', async () => {
    const { bannerSinRed } = await import('@/lib/errors')
    expect(bannerSinRed({ enUnGrupo: true, haySesion: false, hayCopia: false }))
      .not.toMatch(/apuntar/i)
  })

  // Sonda (§E.2): sin esto, una función que devolviera siempre la misma cadena
  // pasaría las cuatro de arriba si esa cadena no dijera ni «apuntar» ni «vimos».
  it('los cuatro estados no dicen todos lo mismo', async () => {
    const { bannerSinRed } = await import('@/lib/errors')
    const dichos = new Set([
      bannerSinRed({ enUnGrupo: true, haySesion: true, hayCopia: true }),
      bannerSinRed({ enUnGrupo: true, haySesion: true, hayCopia: false }),
      bannerSinRed({ enUnGrupo: false, haySesion: true, hayCopia: false }),
    ])
    expect(dichos.size, 'el banner volvió a ser uno solo').toBe(3)
  })
})

/**
 * Spec C / R1 — La cadencia del sondeo, **suya y no la de nadie**.
 *
 * `esperasDeReintento()` la usan `GroupView.tsx:246` y `:304` y la fija
 * `unit/conectividad.test.ts:57`: tocarla para esto cambiaría dos
 * comportamientos que esta spec no toca.
 */
describe('Spec C · el sondeo sube y luego se sostiene', () => {
  it('sube 2, 4, 8, 16, 30 y se queda en 30', async () => {
    const { esperaDeSondeo } = await import('@/lib/errors')
    expect([0, 1, 2, 3, 4].map(esperaDeSondeo)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000])
    expect(esperaDeSondeo(5), 'no se sostiene: seguiría creciendo').toBe(30_000)
    expect(esperaDeSondeo(99)).toBe(30_000)
  })

  // Sonda: una cota que no acota —o que devuelve 0— dejaría el sondeo
  // martilleando un servicio pausado.
  it('nunca baja de 2 s ni sube de 30 s', async () => {
    const { esperaDeSondeo } = await import('@/lib/errors')
    for (let n = 0; n < 50; n++) {
      expect(esperaDeSondeo(n)).toBeGreaterThanOrEqual(2_000)
      expect(esperaDeSondeo(n)).toBeLessThanOrEqual(30_000)
    }
  })

  it('no toca la cadencia del reintento de GroupView', async () => {
    const { esperasDeReintento } = await import('@/lib/errors')
    expect(esperasDeReintento(), 'se cambió una cadencia compartida')
      .toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
  })
})

/**
 * Spec J / i1-R3, i4 — **El aviso del rango dice el rango.**
 *
 * `23514` lo levantan cuatro restricciones distintas de este esquema, y sin desviar la de la
 * cantidad, teclear `100` se le anunciaba a alguien como «revisa que no esté vacío y que no
 * sea demasiado largo»: ni una cosa ni la otra, y sin ninguna pista de qué hacer. El borde de
 * la spec promete que la base lo rechaza **y el aviso lo dice**.
 */
describe('Spec J · i4 el 23514 de la cantidad se distingue del resto', () => {
  const comoLoManda = (message: string) => mensajeDe(claseDe({ message, code: '23514' }))

  it('el de la cantidad nombra el rango', () => {
    expect(comoLoManda(
      'new row for relation "items" violates check constraint "items_quantity_num"'))
      .toBe(CANTIDAD_FUERA)
  })

  /**
   * La sonda, y es la que importa: los otros tres `23514` del esquema **no** pueden acabar
   * diciendo lo de la cantidad. Sin ella, desviar el código entero cumpliría la fila de
   * arriba y estropearía los tres de al lado.
   */
  it.each([
    ['el nombre en blanco', 'violates check constraint "items_name_check"'],
    ['el nombre demasiado largo', 'violates check constraint "items_name_len"'],
    ['la cantidad demasiado larga', 'violates check constraint "items_quantity_len"'],
    ['el nombre del grupo', 'violates check constraint "groups_name_check"'],
  ])('y %s sigue siendo el aviso de texto', (_n, message) => {
    expect(comoLoManda(message), 'se desvió un 23514 que no es el de la cantidad').toBe(TEXTO)
  })

  it('la sonda al revés — sin el desvío, el rango se anuncia como problema de texto', () => {
    // Se ataca el criterio: si `ES_CANTIDAD` dejara de distinguir, esto es lo que se vería.
    expect(TEXTO, 'los dos avisos son el mismo: la fila de arriba no prueba nada')
      .not.toBe(CANTIDAD_FUERA)
  })
})
