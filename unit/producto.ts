import { readdirSync, statSync } from 'node:fs'

/**
 * AF8 — «El producto» estaba escrito tres veces: en `unit/textoCrudo.ts`, en
 * `unit/cota-sesion.test.ts` y —con otro alcance— en el arnés. AE9 añadió
 * `proxy.ts` a **una** de las tres, así que la cota de D.6 seguía sin mirar el
 * fichero que corre en cada petición. Es la cicatriz X2: dos copias del mismo
 * análisis divergen, y la que se usa menos se queda atrás.
 */
export function ficherosDeProducto(): string[] {
  const salida: string[] = []
  const recorrer = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const ruta = `${dir}/${e}`
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue }
      if (/\.(ts|tsx)$/.test(ruta)) salida.push(ruta)
    }
  }
  recorrer('app'); recorrer('lib')
  /**
   * Producto que no vive en una carpeta: corre en cada petición. Se descubre
   * mirando la raíz, no con una lista. Se aceptan los dos nombres porque los dos
   * son producto donde existan: en Next 16 es `proxy.ts` y en versiones
   * anteriores `middleware.ts` — AH8 corrigió aquí un comentario que decía haber
   * retirado el segundo mientras la expresión de abajo seguía casándolo.
   */
  for (const suelto of readdirSync('.')) {
    if (/^(proxy|middleware)\.tsx?$/.test(suelto)) salida.push(suelto)
  }
  return salida
}

/** La misma lista, en la forma que `it.each` espera. */
export const ficherosDeProductoEach = (): [string][] =>
  ficherosDeProducto().map(r => [r] as [string])
