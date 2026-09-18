import { describe, it, expect } from 'vitest'
import { claseDe, clasificar, mensajeDe, refinarSinRed, esperasDeReintento, traducirError,
  EN_COLA, SERVIDOR, RED } from '../lib/errors'

/**
 * R1 / DoD 1 — Los tres estados. La clase **no se puede decidir por el texto**:
 * medido, un proyecto pausado llega como `{ message: "Project is paused" }` sin
 * `code` y sin `status`, y con cuerpo HTML el HTML entero acaba en `message`.
 *
 * Lo que sí es fiable, y también está medido: **todo error de PostgREST trae
 * código** — `PGRST202`, `42703`, `23514`. Así que «sin código» significa que no
 * contestó nadie que hable PostgREST, y ahí la red del usuario decide cuál de los
 * dos estados es.
 */
describe('R1 sin código, la red decide de quién es el fallo', () => {
  const pausado = { message: 'Project is paused' }
  const transporte = { message: 'TypeError: fetch failed', details: 'ECONNREFUSED' }

  it.each([
    ['un proyecto pausado', pausado],
    ['un transporte roto', transporte],
    ['una pasarela que devuelve HTML', { message: '<html><body>paused</body></html>' }],
  ])('con red, %s es del servidor', (_n, error) => {
    expect(refinarSinRed(claseDe(error), true)).toBe('servidor')
  })

  it.each([
    ['un proyecto pausado', pausado],
    ['un transporte roto', transporte],
  ])('sin red, %s es de la conexión', (_n, error) => {
    expect(refinarSinRed(claseDe(error), false)).toBe('red')
  })

  it('y con código, manda el código: la red no interviene', () => {
    const denegado = { code: '42501', message: 'permission denied for table items' }
    expect(refinarSinRed(claseDe(denegado), false)).toBe('sin-acceso')
    expect(refinarSinRed(claseDe(denegado), true)).toBe('sin-acceso')
  })

  it('en el servidor, donde no hay navegador, se asume que la red está bien', () => {
    expect(claseDe(pausado)).toBe('servidor')
  })

  it('los dos mensajes son distintos y ninguno culpa a quien no es', () => {
    expect(mensajeDe('servidor')).toBe(SERVIDOR)
    expect(mensajeDe('red')).toBe(RED)
    expect(SERVIDOR).not.toBe(RED)
    expect(SERVIDOR.toLowerCase()).not.toContain('conexión')
  })
})

/**
 * R2 / DoD 4 — El reintento va acotado en número y en espera (D.6). Sin cota, un
 * servicio que no despierta deja al cliente reintentando para siempre.
 */
describe('R2 el reintento tiene fondo', () => {
  const esperas = esperasDeReintento()

  it('el número de intentos es finito', () => {
    expect(esperas.length).toBeGreaterThan(2)
    expect(esperas.length).toBeLessThanOrEqual(6)
  })

  it('las esperas crecen y tienen tope', () => {
    for (let i = 1; i < esperas.length; i++) expect(esperas[i]).toBeGreaterThanOrEqual(esperas[i - 1])
    expect(Math.max(...esperas)).toBeLessThanOrEqual(10_000)
  })

  it('y el total no encierra a nadie más de un minuto', () => {
    expect(esperas.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000)
  })
})

/**
 * R10 / DoD 17 — Deuda 7. `text.includes('abort')` atrapaba
 * `current transaction is aborted…`, que es un fallo del servidor, y lo anunciaba
 * como falta de conexión.
 */
describe('R10 una transacción abortada no es falta de conexión', () => {
  const abortada = 'current transaction is aborted, commands ignored until end of transaction block'

  it('con su código de Postgres', () => {
    expect(clasificar('25P02', abortada)).not.toBe('red')
  })

  it('y también sin código', () => {
    expect(clasificar(null, abortada)).not.toBe('red')
  })

  it('pero un fallo de transporte de verdad sigue siendo red', () => {
    expect(clasificar(null, 'TypeError: failed to fetch')).toBe('red')
  })
})

/**
 * I6 / DoD 27 — Las acciones de servidor pasaban por `traducirError`, que iba
 * derecho a `clasificar` sin la regla del código primero. Con el proyecto pausado
 * seguían diciendo «No se ha podido completar la operación» — la frase exacta que
 * R2 vino a borrar, viva en las cuatro acciones.
 */
describe('I6 una acción de servidor con el proyecto pausado lo dice', () => {
  it.each([
    ['pausado', { message: 'Project is paused' }],
    ['pasarela caída', { message: '<html>502</html>' }],
    ['transporte roto', { message: 'TypeError: fetch failed' }],
  ])('con %s, la acción anuncia que despierta', (_n, error) => {
    const r = traducirError(error as { message: string })
    expect(r.clase).toBe('servidor')
    expect(r.mensaje).toBe(SERVIDOR)
  })

  it('y con código sigue mandando el código', () => {
    expect(traducirError({ message: 'duplicate key', code: '23505' }).clase).toBe('duplicado')
  })
})

/**
 * Spec B / R3 — **El hecho «encolado» tiene texto propio.**
 *
 * `SERVIDOR` lo pintaban tres hechos: una carga fallida, una edición fallida y un
 * alta encolada. Sólo en el tercero el producto está guardado, así que un texto
 * para los tres o miente en dos o no tranquiliza en ninguno. Y «lo reintentamos
 * solo» era falso a partir del segundo 23 en los tres, porque eso es lo que dura
 * `esperasDeReintento()`.
 */
describe('R3 el aviso de lo encolado no comparte texto con lo que no se guardó', () => {
  it('DoD 12: es una constante propia, y `SERVIDOR` se queda donde estaba', () => {
    expect(EN_COLA, 'volvió a ser el mismo texto que la carga fallida').not.toBe(SERVIDOR)
    expect(EN_COLA, 'volvió a ser el texto que culpa a la conexión del usuario').not.toBe(RED)
    expect(mensajeDe('servidor'),
      'se movió el texto de la clase en vez de darle uno propio a la cola').toBe(SERVIDOR)
  })

  /**
   * DoD 14 — Las tres cosas que este texto no puede volver a hacer, cada una con su
   * sonda: el predicado tiene que **cazar** la versión mala, o no distingue nada.
   */
  const promeseReintento = (t: string) => /reintent|inténtalo|intentalo/i.test(t)
  const culpaALaRed = (t: string) => /conexi[oó]n|sin red|wifi/i.test(t)
  const diceDondeEsta = (t: string) => /guardad[oa]/i.test(t)

  it('DoD 14: no promete un reintento, no culpa a la red, y dice dónde quedó', () => {
    expect(promeseReintento(EN_COLA), 'promete un reintento que muere a los 23 s').toBe(false)
    expect(culpaALaRed(EN_COLA), 'culpa a la conexión de quien puede tenerla perfecta').toBe(false)
    expect(diceDondeEsta(EN_COLA), 'no dice lo único que tranquiliza: dónde está el producto').toBe(true)
  })

  it('y las sondas: los tres predicados cazan la versión mala', () => {
    expect(promeseReintento(SERVIDOR), 'el predicado no caza «lo reintentamos solo»').toBe(true)
    expect(culpaALaRed(RED), 'el predicado no caza «No hay conexión»').toBe(true)
    expect(diceDondeEsta(SERVIDOR), 'el predicado da por bueno un texto que no dice dónde').toBe(false)
  })
})
