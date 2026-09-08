import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fugasDeError } from './fugaDeError'
import type { Exencion } from './contaminacion'
import { FORMAS_CONTAMINADAS, FORMAS_LIMPIAS } from './muestras/contaminadas'
import { sql, pool } from './helpers'
import { normNombre } from '../lib/items'

afterAll(async () => { await pool.end() })

/**
 * T4 / DoD 33, 34 — Tercera versión de esta guarda. La primera era una expresión
 * regular (cazaba 1 de 6 formas); la segunda listaba seis y se colaron cinco más.
 * Ésta sigue la **propiedad**: nada que salga de una acción puede venir del error
 * de la base. Y la exención se resuelve por **símbolo** —lo importado del módulo
 * de errores—, no por nombre, porque un `describeError` local la desactivaba.
 */
describe('T4 ninguna acción deja escapar el error de la base', () => {
  const FUENTE = readFileSync('app/actions.ts', 'utf8')

  it('app/actions.ts está limpio', () => {
    expect(fugasDeError(FUENTE)).toEqual([])
  })

  it.each([
    ['devuelto directo', 'if (error) return { error: error.message }'],
    ['en plantilla', 'if (error) return { error: `${error.message}` }'],
    ['lanzado', 'if (error) throw new Error(error.message)'],
    ['por variable', 'const m = error.message; return { error: m }'],
    ['desestructurado', 'const { message } = error; return { error: message }'],
    ['desestructurado con alias', 'const { message: m2 } = error; return { error: m2 }'],
    ['por corchetes', "return { error: error['message'] }"],
    ['por corchetes con variable', 'return { error: error[k] }'],
    ['alias del error entero', 'const e2 = error; return { error: e2.message }'],
    ['serializado', 'return { error: JSON.stringify(error) }'],
  ])('caza la forma %s', (_n, forma) => {
    const contaminado = `${FUENTE}\nexport function fuga() { ${forma} }\n`
    expect(fugasDeError(contaminado), 'la forma se coló').not.toEqual([])
  })

  // DoD 34 — la exención es por símbolo: un traductor local no exime nada.
  it('un describeError local no desactiva la guarda', () => {
    const contaminado = `${FUENTE}
const describeError2 = (s: string) => s
const describeError = (s: string) => s
export function fuga() { const { error } = { error: { message: 'x' } }; return { error: claseDe(error) } }
`
    expect(fugasDeError(contaminado), 'basta declarar un traductor local para apagarla')
      .not.toEqual([])
  })

  it('el uso legítimo dentro del traductor no se marca', () => {
    expect(fugasDeError(`import { claseDe } from '@/lib/errors'
export function ok() { const { error } = { error: { message: 'x', code: '1' } }
  if (error) return { error: claseDe(error) } }`)).toEqual([])
  })

  it('leer sólo el código no es una fuga', () => {
    expect(fugasDeError(`export function ok() { const { error } = { error: { code: '1' } }
  if (error?.code === '23505') return { error: 'ya está' } }`)).toEqual([])
  })
})

/**
 * S12 / DoD 28 — `btrim` de Postgres recorta **espacios**; `trim()` de JS se lleva
 * además tabuladores, saltos y el espacio duro. Con esa diferencia, la pantalla
 * fundía lo que la base separa.
 */
describe('S12 la normalización del cliente y la de la base coinciden', () => {
  const CASOS = ['  pan  ', '\tpan\t', '\npan\n', ' pan ', 'Plátano', 'Piña', 'CEBOLLA']

  it.each(CASOS)('%j se normaliza igual en las dos', async (entrada) => {
    const [fila] = await sql<{ n: string }>(
      `select translate(lower(btrim($1)),
         'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
         'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') as n`, [entrada])
    expect(normNombre(entrada)).toBe(fila.n)
  })
})

/**
 * U4 / DoD 46, 47 — Cuarta versión de la guarda. La tercera decía exención "por
 * símbolo" y no lo era: eximía cualquier `FunctionDeclaration`, así que
 * `function loQueSea(…)` la apagaba entera, y once formas de propagación se
 * colaban. Ahora la exención es **el nombre importado del módulo de errores**.
 */
describe('U4 la contaminación se propaga por todas sus formas', () => {
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\n"

  it.each([
    ['spread', 'return { ...error }'],
    ['cast', 'return { error: error as unknown as string }'],
    ['satisfies', 'return { error: (error satisfies object) }'],
    ['asignación a variable ya declarada', 'let out; out = error; return { error: out }'],
    ['propiedad de objeto', 'const o = { e: error }; return { error: o.e }'],
    ['elemento de array', 'const a = [error]; return { error: a[0] }'],
    ['ternario', 'return { error: error ? error.message : null }'],
    ['coalescencia', 'return { error: error.message || null }'],
    ['serializado', 'return { error: JSON.stringify(error) }'],
    ['por función intermedia', 'function envolver(e: unknown) { return e }; return { error: envolver(error) }'],
    ['plantilla', 'return { error: `${error.message}` }'],
  ])('caza %s', (_n, forma) => {
    expect(fugasDeError(`${cabecera}export function fuga() { ${forma} }`), 'la forma se coló')
      .not.toEqual([])
  })

  // DoD 47 — una función declarada cualquiera ya no exime nada.
  it.each([
    ['describeError2', 'function describeError2(s: unknown) { return s }'],
    ['loQueSea', 'function loQueSea(s: unknown) { return s }'],
  ])('una función declarada llamada %s no exime', (nombre, declaracion) => {
    // V2 — el caso anterior no LLAMABA a la función, así que restaurar la
    // exención lo dejaba verde: no podía fallar por la regresión que nombra.
    expect(fugasDeError(`${cabecera}${declaracion}
export function fuga() { return { error: ${nombre}(error) } }`), 'la función declarada eximió')
      .not.toEqual([])
  })

  it('V3 — `throw error` no se cuela', () => {
    expect(fugasDeError(`${cabecera}export function fuga() { throw error }`)).not.toEqual([])
    expect(fugasDeError(`${cabecera}export function fuga() { throw new Error(error.message) }`))
      .not.toEqual([])
  })

  it('el traductor importado sigue eximiendo', () => {
    expect(fugasDeError(`${cabecera}export function ok() { return { error: claseDe(error) } }`))
      .toEqual([])
  })
})

/** Z3 / DoD 84 — el mismo banco, por la otra puerta. */
describe('Z3 la guarda del arnés caza el banco compartido', () => {
  /**
   * AB1 — La cabecera llevaba `const p = { error }`, que **por sí sola** dispara
   * la guarda: las 30 aserciones pasaban pasara lo que pasara con la forma que
   * probaban. Es AA1 otra vez, en la guarda hermana, una iteración después.
   */
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\nconst p: Record<string, unknown> = {}\n"

  // AB1 / DoD 91 — el control que faltaba: la cabecera, sola, no puede disparar
  // la guarda. Llevaba `const p = { error }` y hacía pasar las 30 aserciones
  // pasara lo que pasara con la forma que probaban.
  it('la cabecera sola no dispara la guarda', () => {
    expect(fugasDeError(cabecera), 'la cabecera dispara: las aserciones no prueban nada')
      .toEqual([])
  })

  /**
   * AC3 — Seis de las 38 aserciones **no podían fallar**: su `previo` dispara la
   * guarda él solo —un getter, un método, una función declarada que devuelven el
   * error— y con `expr` sustituido por `null` el hallazgo salía igual. Es AA1/AB1
   * por tercera vez, un nivel más abajo.
   *
   * Se afirma que el hallazgo cae en **la línea de la salida**, que es la única
   * que la forma bajo prueba controla.
   */
  const conSalidaEnLinea = (previo: string, expr: string) => {
    const fuente = `${cabecera}${previo}\nexport function fuga() { return { error: ${expr} } }`
    return { fugas: fugasDeError(fuente), linea: fuente.split('\n').length }
  }

  it.each(FORMAS_CONTAMINADAS as unknown as [string, string, string][])(
    'caza %s en la línea de la salida', (_n, previo, expr) => {
      const { fugas, linea } = conSalidaEnLinea(previo, expr)
      expect(fugas, 'esta forma se le cuela a la guarda del arnés')
        .toContain(`return (línea ${linea})`)
    })

  // AC3 — la contraprueba de la contraprueba: con `null` en lugar de la forma,
  // la línea de la salida NO puede aparecer. Sin esto, afirmar la línea sería
  // otra tautología si la guarda marcase esa línea por cualquier motivo.
  /**
   * AD8 — Este control iba sobre las 42 filas, y **10 tienen `previo` vacío**:
   * para ésas la entrada es la misma cadena diez veces, así que eran diez copias
   * de una aserción que no prueba nada de la forma que nombra. Se corre donde hay
   * `previo` que pueda ensuciar por su cuenta, y el caso vacío se afirma una vez.
   */
  it('sin forma y sin previo, la salida está limpia', () => {
    const { fugas, linea } = conSalidaEnLinea('', 'null')
    expect(fugas).not.toContain(`return (línea ${linea})`)
  })

  it.each(FORMAS_CONTAMINADAS.filter(([, p]) => p !== '') as unknown as [string, string, string][])(
    'y con null en su lugar, %s deja la salida limpia', (_n, previo) => {
      const { fugas, linea } = conSalidaEnLinea(previo, 'null')
      expect(fugas).not.toContain(`return (línea ${linea})`)
    })
})

/** AC9 / DoD 109 — la mitad negativa: lo limpio pasa. */
describe('AC9 la guarda del arnés no marca lo que está limpio', () => {
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\n"
  it.each(FORMAS_LIMPIAS as unknown as [string, string, string][])(
    'deja pasar %s', (_n, previo, expr) => {
      expect(fugasDeError(`${cabecera}${previo}\nexport function ok() { return { error: ${expr} } }`),
        'la guarda marca lo limpio: entonces marcarlo todo la haría inútil').toEqual([])
    })
})

/**
 * AB2 / DoD 93 — La revisión demostró esta fuga **sobre el fichero real** con la
 * suite entera en verde: una flecha de cuerpo conciso devolvía el crudo de
 * Postgres al cliente y ninguna guarda se enteraba. Decidir por la forma
 * sintáctica de la salida obligaba a enumerarlas todas; ahora decide la
 * contaminación.
 */
describe('AB2 la fuga real que demostró la revisión', () => {
  const REAL = readFileSync('app/actions.ts', 'utf8')

  it('el fichero real está limpio', () => {
    expect(fugasDeError(REAL)).toEqual([])
  })

  it.each([
    ['flecha de cuerpo conciso', 'const envolver = () => error\nexport function fuga() { return { error: JSON.stringify(envolver()) } }'],
    ['IIFE', 'export function fuga() { return { error: String((() => error)()) } }'],
    ['generador atado a const', 'const g = function* () { yield error }\nexport function fuga() { return { error: String([...g()][0]) } }'],
    ['campo de clase', 'class C { e = error }\nexport function fuga() { return { error: String(new C().e) } }'],
  ])('inyectada en el fichero real, %s se caza', (_n, fuga) => {
    expect(fugasDeError(`${REAL}\n${fuga}\n`), 'la fuga salió sin que nada se pusiera rojo')
      .not.toEqual([])
  })
})

/** AB5 / DoD 97 — el módulo se ancla: `./mis/errors` no puede eximir. */
describe('AB5 la exención es el módulo real, no cualquiera que acabe igual', () => {
  it.each(['./mis/errors', '@/lib/otros/errors', '../vendor/errors'])(
    'un import desde %j no exime', (modulo) => {
      expect(fugasDeError(
        `import { claseDe } from '${modulo}'
         const error = { message: 'x' }
         export function fuga() { return { error: claseDe(error) } }`),
        'un módulo cualquiera que acabe en /errors apagó la guarda').not.toEqual([])
    })

  it('el módulo real sí exime', () => {
    expect(fugasDeError(
      `import { claseDe } from '@/lib/errors'
       const error = { message: 'x' }
       export function fuga() { return { error: claseDe(error) } }`)).toEqual([])
  })
})

/**
 * AC2 / DoD 100 — Las seis formas que la revisión midió sobre `app/actions.ts`
 * REAL, con la suite entera en verde y las cuatro salidas enumeradas mirando a
 * otro lado. No son variantes de laboratorio: cada una es un refactor que un
 * compañero puede escribir mañana sin sospechar nada.
 *
 * Se inyectan en el fichero real y no en una muestra porque el defecto que se
 * repite nueve rondas es exactamente ése: la guarda pasa el banco y no ve el
 * fichero. Siembra: esto no EJECUTA la acción —eso lo cubren los e2e—, sólo
 * comprueba que la guarda la vería.
 */
describe('AC2 las seis fugas que la revisión sacó del fichero real', () => {
  const REAL_ = readFileSync('app/actions.ts', 'utf8')
  it.each([
    ['flecha exportada de cuerpo conciso', 'export const f1 = async () => error'],
    ['objeto con una propiedad que no se llama error',
      'export async function f2() { return { mensaje: error.message } }'],
    ['generador exportado', 'export async function* f3() { yield error.message }'],
    ['constante de módulo exportada', 'export const f4 = error.message'],
    ['export default', 'export default error.message'],
    ['campo asignado y luego devuelto',
      'export function f6() { const r: any = {}; r.error = error.message; return r }'],
  ])('caza %s', (_n, fuga) => {
    expect(fugasDeError(`${REAL_}\n${fuga}\n`), 'la fuga salió sin que nada se pusiera rojo')
      .not.toEqual([])
  })

  // El control que hace que las seis puedan fallar: sin inyectar nada, limpio.
  it('y el fichero real, sin inyectar nada, sigue limpio', () => {
    expect(fugasDeError(REAL_)).toEqual([])
  })
})

/**
 * AD8 / DoD 121 — El banco negativo sólo demuestra algo si **muere** al quitar la
 * exención que lo deja pasar. La revisión midió que borrando (a), (c) o
 * `dentroDeTraductor` las 8 filas seguían verdes: la exención que carga con todo
 * el riesgo de falso positivo tenía cobertura **cero**.
 *
 * Aquí se apaga cada exención a propósito y se exige que alguna fila caiga. Es la
 * sonda que §E.2 pide para una guarda cuyo valor está en lo que NO marca.
 */
describe('AD8 cada exención tiene quien la mate', () => {
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\n"
  const limpias = (sin?: Exencion) => FORMAS_LIMPIAS.filter(([, previo, expr]) =>
    fugasDeError(`${cabecera}${previo}\nexport function ok() { return { error: ${expr} } }`,
      'actions.ts', sin).length > 0)

  it('con las tres puestas, ninguna fila del banco negativo se marca', () => {
    expect(limpias().map(f => f[0])).toEqual([])
  })

  it.each(['traductor', 'lectura', 'atadura'] as const)(
    'sin la exención %s, el banco negativo se pone rojo', (sin) => {
      expect(limpias(sin).length,
        `quitar la exención "${sin}" no puso roja ni una fila: nadie la cubre`)
        .toBeGreaterThan(0)
    })
})

/**
 * AD7 / DoD 119-120 — Los cuatro agujeros y los dos falsos positivos que la
 * revisión midió inyectando en `app/actions.ts` real.
 */
describe('AD7 los agujeros medidos del motor', () => {
  const REAL2 = readFileSync('app/actions.ts', 'utf8')
  it.each([
    ['asignación por índice', 'export function h1() { const a: any = []; a[0] = error; return { error: a[0] } }'],
    ['patrón anidado de objeto', 'export function h2() { const { a: { b } } = error as any; return { error: b } }'],
    ['patrón anidado de array', 'export function h3() { const [[c]] = [[error]]; return { error: c } }'],
    ['export let asignado después', 'export let h4: any; h4 = error'],
    ['propiedad de una constante exportada', 'export const h5: any = {}; h5.ultimo = error'],
    ['campo de una clase exportada', 'export class H6 { m: any; f() { this.m = error } }'],
  ])('caza %s', (_n, fuga) => {
    expect(fugasDeError(`${REAL2}\n${fuga}\n`), 'este agujero seguía abierto').not.toEqual([])
  })

  it.each([
    ['la desestructuración con alias, que es la forma limpia',
      "export async function ok1() { const { data, error: fallo } = await supabase.rpc('x')\n" +
      '  if (fallo) return traducirConSesion(fallo, () => supabase.auth.getUser())\n  return { data } }'],
    ['leer sólo el código',
      "export function ok2() { if (error.code === '23505') return { error: 'ya está' }\n  return {} }"],
  ])('y NO marca %s', (_n, limpio) => {
    expect(fugasDeError(`${REAL2}\n${limpio}\n`),
      'la guarda castiga la forma limpia: eso empuja a escribir la sucia').toEqual([])
  })
})
