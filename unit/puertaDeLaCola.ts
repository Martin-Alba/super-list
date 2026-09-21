import type { Pendiente } from '@/lib/local'

/**
 * Spec E — **El doble de la puerta, en un solo sitio.** `leerCola` filtra y no borra;
 * `barrerCaducados` barre, honra el booleano del almacén y devuelve también lo vivo. Un
 * doble que devolviera la cola cruda le diría a la vista que no hay nada caducado, y los
 * casos de caducidad medirían el doble.
 *
 * Vive aquí porque estaba escrito **byte a byte en dos ficheros**, que es la misma
 * cicatriz que este ciclo lleva persiguiendo: tres copias de una regla que ya habían
 * divergido en tres cosas.
 */
export function dobleDeLaPuerta(
  leer: () => Pendiente[], poner: (vivos: Pendiente[]) => void,
  reparte: (c: Pendiente[], ahora: number) => { vivos: Pendiente[]; caducados: Pendiente[] },
  quitar: (id: string) => Promise<boolean>,
) {
  return {
    leerComoLaPuerta: async () => reparte(leer(), Date.now()).vivos,
    barrerComoElDueno: async () => {
      const { vivos, caducados } = reparte(leer(), Date.now())
      const idas = await Promise.all(caducados.map(p => quitar(p.id)))
      poner(vivos)
      return { vivos, descartadas: idas.filter(Boolean).length }
    },
  }
}
