import { mismoProducto } from './items'
import type { Pendiente } from './local'

/**
 * Spec C / R3 — La regla de la cola, compartida por las dos pantallas que pueden
 * apuntar sin red: `app/g/[id]/GroupView.tsx` y la cáscara `app/sin-conexion`.
 *
 * Sale del componente porque lo que divergió en la cicatriz N3 fue **la regla**,
 * no el cableado: el mismo bloque escrito dos veces ya decidía distinto según la
 * rama. Los efectos —devolver el texto al campo, avisar, pintar la ficha— se
 * quedan en cada pantalla: `avisar` es el mecanismo de la Spec B, y traerlo aquí
 * dejaría las dos specs sin poder construirse por separado.
 *
 * Pura a propósito: el identificador y el reloj entran como parámetros, para que
 * la prueba pueda fijarlos y para que no haya dos fuentes de tiempo.
 */
export type Decision =
  | { accion: 'duplicado' }
  | { accion: 'encolar'; pendiente: Pendiente }

export function decidirEncolar(entrada: {
  usuario: string
  grupo: string
  nombre: string
  cantidad: string | null
  /** Lo que se ve en pantalla: la lista del servidor, o la instantánea local. */
  visibles: { name: string }[]
  cola: Pendiente[]
  id: string
  ahora: number
}): Decision {
  const { usuario, grupo, nombre, cantidad, visibles, cola, id, ahora } = entrada
  const repetido = visibles.some(i => mismoProducto(i.name, nombre))
    || cola.some(p => p.grupo === grupo && mismoProducto(p.nombre, nombre))
  if (repetido) return { accion: 'duplicado' }
  return { accion: 'encolar', pendiente: { id, usuario, grupo, nombre, cantidad, creado: ahora } }
}
