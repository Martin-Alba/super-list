import { describe, it, expect } from 'vitest'
import { VIDA_COLA_MS, reparte, siguienteEnCola, type Pendiente } from '../lib/local'

const p = (id: string, creado: number, grupo = 'g1'): Pendiente =>
  ({ id, usuario: 'u1', grupo, nombre: id, cantidad: null, creado })

/**
 * R5 / DoD 9 — La cola caduca a las 24 h. La política es una función pura y vive
 * aparte del almacén: una regla de caducidad enterrada en una transacción de
 * IndexedDB no la puede afirmar nadie sin un navegador.
 */
describe('R5 lo que pasa de 24 horas se descarta', () => {
  const ahora = 1_000_000_000_000

  it('la vida es de un día', () => {
    expect(VIDA_COLA_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('reparte en vivos y caducados por el borde exacto', () => {
    const justo = p('justo', ahora - VIDA_COLA_MS)
    const pasado = p('pasado', ahora - VIDA_COLA_MS - 1)
    const nuevo = p('nuevo', ahora - 1_000)
    const { vivos, caducados } = reparte([pasado, justo, nuevo], ahora)
    expect(vivos.map(x => x.id)).toEqual(['justo', 'nuevo'])
    expect(caducados.map(x => x.id)).toEqual(['pasado'])
  })

  it('una cola vacía no inventa nada', () => {
    expect(reparte([], ahora)).toEqual({ vivos: [], caducados: [] })
  })
})

/**
 * R4 / DoD 6 — El drenado es FIFO y de uno en uno: dos envíos a la vez sobre el
 * mismo grupo son la carrera que D.2 prohíbe resolver en memoria.
 */
describe('R4 se drena en orden y de uno en uno', () => {
  const hoy = 1_000_000_000_000
  it('sale el más antiguo del grupo, no el primero de la lista', () => {
    const cola = [p('c', hoy - 300), p('a', hoy - 500), p('b', hoy - 400)]
    expect(siguienteEnCola(cola, 'g1', hoy)?.id).toBe('a')
  })

  it('no saca nada de otro grupo', () => {
    expect(siguienteEnCola([p('x', hoy - 100, 'otro')], 'g1', hoy)).toBeNull()
  })

  it('con la cola vacía no hay siguiente', () => {
    expect(siguienteEnCola([], 'g1', hoy)).toBeNull()
  })
})

/**
 * Spec B / iteración 1 · i1-R1 — **Lo caducado no se envía.**
 *
 * La regla de las 24 h vivía sólo en el efecto de apertura, así que el drenado
 * podía publicar al grupo entero un producto que la app promete descartar. Medido
 * en el navegador por la revisión: con una entrada de 25 h sembrada, `["caducado"]`
 * en la base en 4 de 4 corridas, y también **sin montaje de por medio** cuando la
 * escribía otra pestaña. Se cierra donde vive la política, no donde se vio: la
 * misma función pura decide lo que se descarta y lo que se puede enviar.
 */
describe('i1-R1 el siguiente a enviar nunca es uno caducado', () => {
  const hoy = 1_000_000_000_000
  const viejo = hoy - VIDA_COLA_MS - 1
  const nuevo = hoy - 1_000

  it('i1-3: una cola sólo de caducadas no tiene siguiente', () => {
    expect(siguienteEnCola([p('viejo', viejo)], 'g1', hoy),
      'el drenado publicaría un producto que la regla manda descartar').toBeNull()
  })

  it('i1-3: con mezcla sale la viva, aunque la caducada sea más antigua', () => {
    expect(siguienteEnCola([p('viejo', viejo), p('nuevo', nuevo)], 'g1', hoy)?.id,
      'el FIFO se impuso a la caducidad y salió la vieja').toBe('nuevo')
  })

  // Sonda (§E.2): justo por debajo del límite todavía se envía. Sin esto, un
  // filtro que rechazara todo pasaría los dos casos de arriba.
  it('i1-2: en el límite exacto todavía vale, y se envía', () => {
    expect(siguienteEnCola([p('justo', hoy - VIDA_COLA_MS)], 'g1', hoy)?.id,
      'el filtro se pasó de frenada y ya no envía nada').toBe('justo')
  })
})
