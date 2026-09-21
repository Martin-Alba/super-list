/**
 * Spec I / I-R4 — Estampa la versión del service worker a partir del build.
 *
 * Deuda 31: `VERSION` era un literal escrito a mano, así que los bytes de `sw.js` eran idénticos
 * entre despliegues. El navegador **no reinstala** si los bytes no cambian, y `activate` sólo purga
 * cachés `super-*` distintas de la actual — que nunca las hay. Resultado: el shell se congela en el
 * build de la primera instalación y un arreglo en `/sin-conexion` no le llega nunca a quien ya lo
 * tiene.
 *
 * **Por qué un fichero generado y no estampar `public/sw.js`:** ese fichero está en control de
 * versiones, y un build que lo reescribe deja el árbol sucio en cada `pnpm build`. El generado va
 * ignorado por git, y `sw.js` lo trae con `importScripts`.
 *
 * **De dónde sale la versión:** del sha del commit cuando lo hay —`VERCEL_GIT_COMMIT_SHA` en el
 * despliegue, `git rev-parse` en local—, que es exactamente «cambió el despliegue». Sin git,
 * la hora: peor, pero nunca constante, que es el fallo que esto cierra.
 */
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const sha = process.env.VERCEL_GIT_COMMIT_SHA
  ?? (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { return null } })()
const version = `super-${sha ?? `t${Date.now().toString(36)}`}`

writeFileSync('public/sw-version.js',
  `// Generado por scripts/version-sw.mjs. No se edita a mano y no entra en git.\n` +
  `self.SW_VERSION = '${version}'\n`)
console.log(`sw-version: ${version}`)
