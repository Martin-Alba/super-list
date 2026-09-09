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
  it('sale el más antiguo del grupo, no el primero de la lista', () => {
    const cola = [p('c', 300), p('a', 100), p('b', 200)]
    expect(siguienteEnCola(cola, 'g1')?.id).toBe('a')
  })

  it('no saca nada de otro grupo', () => {
    expect(siguienteEnCola([p('x', 100, 'otro')], 'g1')).toBeNull()
  })

  it('con la cola vacía no hay siguiente', () => {
    expect(siguienteEnCola([], 'g1')).toBeNull()
  })
})
