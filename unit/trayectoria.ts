import { readdirSync, readFileSync } from 'node:fs'

/**
 * AF3 — El ancla de la trayectoria vivía dentro de su propio test, y sus
 * aserciones afirmaban sobre **copias de la lógica redeclaradas allí mismo**: la
 * función sucesora escrita otra vez, la expresión regular escrita otra vez y el
 * catálogo de extensiones escrito otra vez. Medido por la revisión: revertir la
 * mejora anterior daba el mismo veredicto sobre el repositorio real, así que
 * ningún test se ponía rojo. Es §E.3 dentro del fichero escrito para cumplirlo.
 *
 * Ahora la lógica es una función de dos argumentos —el checkpoint y el corpus—,
 * así que el test puede dirigirla con corpus sintéticos y **ponerla roja**.
 */

/** `Z` → `AA`, `AB` → `AC`: el orden es (longitud, alfabético). */
export function siguiente(codigo: string): string {
  const letras = codigo.split('')
  for (let i = letras.length - 1; i >= 0; i--) {
    if (letras[i] !== 'Z') {
      letras[i] = String.fromCharCode(letras[i].charCodeAt(0) + 1)
      return letras.join('')
    }
    letras[i] = 'A'
  }
  return 'A'.repeat(codigo.length + 1)
}

/** La última ronda con fila escrita. `(N–T)` es un rango: cuenta la última. */
export function ultimaRondaConFila(checkpoint: string): string {
  const filas = [...checkpoint.matchAll(/^\| \d+ \(([^)]*)\) \| \d{4}-/gm)]
  const ultima = filas.at(-1)?.[1] ?? ''
  return ultima.split(/[–\-—]/).at(-1)!.trim()
}

/**
 * AF3 — La marca acepta cualquier grafía. La revisión midió ocho que esquivaban
 * la anterior: `AF-1`, `AF.1`, `AF_1`, `AF  1`, `af1`, `AF001`, `AF#1` y el guion
 * no-ASCII. Ninguna de ellas es rara: son la forma en que ocho personas
 * distintas escriben la misma etiqueta.
 */
export const marcaDeRonda = (codigo: string): RegExp =>
  // AG5 — Separadores hasta tres, y también `:` `(` `/`. Y **sin** `i`: las
  // etiquetas de ronda son mayúsculas, y con la bandera `marcaDeRonda('AV')`
  // casaba con las etiquetas `av4` de los e2e — un falso positivo esperando a
  // que el ciclo llegara a esa letra.
  new RegExp(`\\b${codigo}[\\s._#:(/\\-‐-―]{0,3}\\d{1,4}\\b`)

/**
 * Devuelve la ronda que ya está en el corpus y no tiene fila, o `null` si la
 * trayectoria está al día. Se mira **una sola** etiqueta —la sucesora de la
 * última fila— para que ningún token accidental de otras letras intervenga.
 */
export function rondaSinFila(checkpoint: string, corpus: string): string | null {
  /**
   * AG5 — Miraba **sólo** la sucesora, así que saltarse una letra la esquivaba:
   * medido, con la última fila en AF, una ronda etiquetada AH o AI pasaba. Se
   * miran las tres siguientes, que cubre el salto sin abrir la puerta a que un
   * token accidental de otras letras intervenga.
   */
  let codigo = ultimaRondaConFila(checkpoint)
  for (let i = 0; i < 3; i++) {
    codigo = siguiente(codigo)
    if (marcaDeRonda(codigo).test(corpus)) return codigo
  }
  return null
}

/** Todo el texto del repositorio, menos el checkpoint, que es donde se escribe. */
export function corpusDelRepositorio(excluir: string[] = ['./docs/CHECKPOINT.md']): string {
  const trozos: string[] = []
  const recorrer = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue
      const ruta = `${dir}/${e.name}`
      if (e.isDirectory()) { recorrer(ruta); continue }
      // Se descarta lo binario, que es una propiedad del fichero. Un catálogo de
      // extensiones permitidas dejaba fuera `.txt`, `.css`, `.yml`…
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|lock)$/i.test(e.name)) continue
      // AH8 — 422 KB de hashes que nadie escribe a mano: superficie regalada
      // para un falso positivo, y ningún sitio donde documentar una ronda.
      if (e.name === 'pnpm-lock.yaml' || e.name === 'tsconfig.tsbuildinfo') continue
      if (excluir.includes(ruta)) continue
      try { trozos.push(readFileSync(ruta, 'utf8')) } catch { /* sin permiso */ }
    }
  }
  recorrer('.')
  return trozos.join('\n')
}
