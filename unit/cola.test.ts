import { describe, it, expect } from 'vitest'
import { decidirEncolar } from '@/lib/cola'
import type { Pendiente } from '@/lib/local'

/**
 * Spec C / R3 — La **regla** de la cola, fuera del componente.
 *
 * Vive aquí porque las dos pantallas que pueden apuntar sin red —`GroupView` y
 * la cáscara— tienen que decidir lo mismo. La cicatriz N3 es exactamente esa
 * deriva: el bloque estaba escrito dos veces y ya había divergido, «sin red un
 * duplicado no se encolaba, y con el servidor caído sí, con ficha doble».
 *
 * Lo que NO sale del componente son los efectos —`devolver`, `avisar`,
 * `setPendientes`—: `avisar` es el mecanismo de la Spec B y acoplarlo aquí
 * dejaría las dos specs sin poder construirse por separado.
 *
 * Qué lo pone rojo (§E.3): cambiar el criterio de duplicado en un sitio.
 */
const pendiente = (grupo: string, nombre: string): Pendiente => ({
  id: `p-${nombre}`, usuario: 'u1', grupo, nombre, cantidad: null, creado: 0,
})

const base = {
  usuario: 'u1', grupo: 'g1', cantidad: null as string | null,
  visibles: [] as { name: string }[], cola: [] as Pendiente[],
  id: 'nuevo', ahora: 1_000,
}

describe('Spec C · la regla de la cola es una sola', () => {
  it('encola lo que no está', () => {
    const d = decidirEncolar({ ...base, nombre: 'Aceitunas' })
    expect(d.accion).toBe('encolar')
    expect(d.accion === 'encolar' && d.pendiente).toMatchObject({
      id: 'nuevo', usuario: 'u1', grupo: 'g1', nombre: 'Aceitunas', cantidad: null, creado: 1_000,
    })
  })

  it('rechaza lo que ya está en la lista visible', () => {
    expect(decidirEncolar({ ...base, nombre: 'Leche', visibles: [{ name: 'leche' }] }).accion)
      .toBe('duplicado')
  })

  it('rechaza lo que ya está en la cola del mismo grupo', () => {
    expect(decidirEncolar({ ...base, nombre: 'Leche', cola: [pendiente('g1', 'LECHE')] }).accion)
      .toBe('duplicado')
  })

  // La mitad que impide que la regla sea «rechaza todo»: la cola de OTRO grupo
  // no bloquea. Sin esto, un lector que devolviera siempre 'duplicado' pasaría.
  it('la cola de otro grupo no bloquea', () => {
    expect(decidirEncolar({ ...base, nombre: 'Leche', cola: [pendiente('g2', 'Leche')] }).accion)
      .toBe('encolar')
  })

  // §E.2 — la normalización es parte de la regla, no un detalle: sin ella
  // «Leche» y «leche» serían productos distintos y la ficha saldría doble.
  it.each([['LECHE'], ['  leche  '], ['Leche']])('normaliza %j como duplicado', (visible) => {
    expect(decidirEncolar({ ...base, nombre: 'leche', visibles: [{ name: visible }] }).accion)
      .toBe('duplicado')
  })
})
