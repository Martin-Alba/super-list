import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { relative } from 'node:path'

/**
 * Spec A — la puerta no pasa con avisos del linter.
 *
 * R1: `pnpm lint` sale ≠ 0 con un solo aviso. Mecanismo: `--max-warnings 0`.
 * R2: la guarda viaja con esta sonda; sin ella, quitar el flag no lo nota nadie.
 *
 * Capa (§E.1): el requisito dice «`pnpm lint` sale ≠ 0», así que la prueba
 * ejecuta `pnpm lint` y lee su código de salida. Leer `package.json` en busca
 * de la cadena no vale: una cadena presente no es una puerta cerrada.
 *
 * Qué lo pone rojo (§E.3): quitar `--max-warnings 0` del script `lint`.
 */

const SONDA = '.sonda-lint.ts'

// Construidas por concatenación: el barrido de más abajo es un barrido de
// texto, y si estas palabras aparecieran literales se cazaría a sí mismo.
const ESL = `esl${'int'}`
const DISABLE = `${ESL}-disable`
const GLOB = `glo${'bal'}`
const EXPORTED = `expor${'ted'}`
const FLOW = `$Flow${'FixMe'}`

function lint() {
  const r = spawnSync('pnpm', ['lint'], { encoding: 'utf8' })
  return { codigo: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Avisos que eslint declara en su línea de resumen; sin resumen, no hay. */
function avisos(salida: string): number {
  const m = salida.match(/(\d+) warnings?\)/)
  return m ? Number(m[1]) : 0
}

afterAll(() => {
  // `.sonda-config.ts` no puede ir en `.gitignore`: el barrido necesita que
  // git lo vea, y un fichero ignorado no lo ve.
  // Se limpia aquí para que un corte a mitad no deje un fichero commiteable
  // suelto en la raíz.
  for (const f of [SONDA, '.sonda-config.ts']) rmSync(f, { force: true })
})

describe('Spec A · un aviso pone la puerta roja', () => {
  // R2 — la siembra tiene que estar fuera del árbol seguido: si el proceso
  // muere entre el write y el rm, un `git add -A` no se la lleva.
  it('la sonda está excluida del control de versiones', () => {
    const ignorado = () => {
      try { execFileSync('git', ['check-ignore', '-q', '--no-index', SONDA]); return true }
      catch { return false }
    }
    expect(ignorado(), `${SONDA} no está en .gitignore`).toBe(true)
  })

  // DoD 1 — la mitad sembrada.
  it('con un aviso sembrado, `pnpm lint` sale ≠ 0', () => {
    writeFileSync(SONDA, 'const avisoSembrado = 1\n')
    try {
      const { codigo, salida } = lint()
      // Que la siembra sea un AVISO y no un error es lo que hace que este test
      // pruebe el requisito: un error saldría ≠ 0 sin flag ninguno, y entonces
      // el test estaría verde sin que la puerta gobernara nada.
      expect(salida, 'la siembra dejó de producir exactamente un aviso')
        .toMatch(/0 errors, 1 warning\b/)
      expect(codigo, 'la puerta pasó con un aviso encima').not.toBe(0)
    } finally {
      rmSync(SONDA, { force: true })
    }
  }, 60_000)

  // DoD 2 — [REGRESIÓN], verde de partida: el flag no rompe el repo limpio.
  it('[REGRESIÓN] sin siembra, `pnpm lint` sale 0 y con 0 avisos', () => {
    rmSync(SONDA, { force: true })
    const { codigo, salida } = lint()
    expect(avisos(salida), `el repositorio tiene avisos:\n${salida}`).toBe(0)
    expect(codigo, 'la puerta está roja sin siembra').toBe(0)
  }, 60_000)

  // Sonda del lector (§E.2): sin esto, `avisos()` podría devolver 0 siempre y
  // el test de arriba pasaría con cualquier salida.
  it('el lector de avisos distingue una salida con avisos de una sin ellos', () => {
    expect(avisos('✖ 1 problem (0 errors, 1 warning)')).toBe(1)
    expect(avisos('✖ 7 problems (2 errors, 5 warnings)')).toBe(5)
    expect(avisos('✖ 2 problems (2 errors, 0 warnings)')).toBe(0)
    expect(avisos('')).toBe(0)
  })
})

/**
 * Iteración 2 / R2 — la válvula que el flag abre.
 *
 * `--max-warnings 0` gobierna los avisos **visibles**. Una
 * directiva `disable` en línea los saca de la cuenta y la puerta vuelve a salir
 * 0. El Caso borde 2 de la spec bendice ese escape —regla nombrada, motivo
 * escrito— pero nadie lo mira, así que la tercera supresión entraría en verde.
 *
 * Inventario declarado: pares *(fichero, regla)*. Sin la línea a propósito —
 * cualquier edición por encima la movería y esto sería ruido en vez de señal.
 *
 * Límite declarado, medido en la revisión: al ser un multiconjunto de pares,
 * **mover una supresión dentro del mismo fichero y con la misma regla no se
 * distingue**. Importa para la Spec B, que reescribe justo ese fichero.
 *
 * Qué lo pone rojo (§E.3): añadir, quitar o mover una supresión sin declararla.
 */
const SUPRESIONES_DECLARADAS = [
  /**
   * Queda **una**. Eran dos: la Spec B se llevó la de «Una vez por carga fallida»
   * (I6) al sustituir aquel efecto por el que anuncia la clase con una ref viva,
   * que no necesita silenciar nada. Esta guarda lo notó en cuanto pasó, que es
   * para lo que está. La que queda es «Sólo al montar» (I3/K7).
   */
  'app/g/[id]/GroupView.tsx react-hooks/exhaustive-deps',
  /**
   * Spec C / iteración 5 — La salida de la cáscara es un enlace normal y no
   * `next/link`, a propósito. Medido el 2026-09-13: con `next/link`, pulsarla sin
   * red hace fallar un fetch del framework y eso arranca el bucle de
   * `next/dist/esm/client/components/offline.js` —6 HEAD en 10 s al documento
   * autenticado del grupo— encima de las 2 sondas por minuto de la pantalla.
   *
   * Ésta es la declaración que el Caso borde 2 de la Spec A exige: regla nombrada
   * y motivo escrito. Y es la primera vez que estas guardas cazan algo real.
   */
  'app/sin-conexion/page.tsx @next/next/no-html-link-for-pages',
].sort()

type InformeEslint = {
  filePath: string
  suppressedMessages?: { ruleId: string | null }[]
}

/** Pares (fichero relativo, regla) de todo aviso silenciado en línea. */
function supresiones(json: string): string[] {
  const informes = JSON.parse(json) as InformeEslint[]
  return informes
    .flatMap(f => (f.suppressedMessages ?? [])
      .map(m => `${relative(process.cwd(), f.filePath)} ${m.ruleId}`))
    .sort()
}

function supresionesReales(): string[] {
  const r = spawnSync('npx', ['eslint', '--format', 'json'], { encoding: 'utf8' })
  return supresiones(r.stdout)
}

describe('Spec A · un aviso silenciado de más también la pone roja', () => {
  // DoD 3 — [REGRESIÓN], verde de partida.
  it('[REGRESIÓN] el inventario de avisos silenciados es el declarado', () => {
    expect(supresionesReales(), 'alguien silenció un aviso sin declararlo aquí')
      .toEqual(SUPRESIONES_DECLARADAS)
  }, 60_000)

  // DoD 2 — la mitad sembrada: sin esto, la guarda de arriba podría no cazar nada.
  it('con una supresión sembrada fuera del inventario, la guarda sale roja', () => {
    writeFileSync(SONDA, [
      `// ${DISABLE}-next-line @typescript-eslint/no-unused-vars`,
      'const silenciado = 1',
      '',
    ].join('\n'))
    try {
      // El desvío medido, aquí ejecutable: el flag no alcanza a lo silenciado.
      // Si algún día saliera ≠ 0, esta guarda habría dejado de hacer falta.
      expect(lint().codigo, 'la puerta ya caza lo silenciado por su cuenta').toBe(0)

      const reales = supresionesReales()
      expect(reales, 'eslint no registró la siembra como supresión')
        .toContain(`${SONDA} @typescript-eslint/no-unused-vars`)
      expect(reales, 'la guarda no distinguiría una supresión nueva')
        .not.toEqual(SUPRESIONES_DECLARADAS)
    } finally {
      rmSync(SONDA, { force: true })
    }
  }, 60_000)

  // DoD 4 / sonda del lector (§E.2): las tres formas de moverse el inventario.
  it('el lector caza una supresión de más, una de menos y una movida de fichero', () => {
    const raiz = process.cwd()
    const informe = (fichero: string, reglas: string[]) =>
      ({ filePath: `${raiz}/${fichero}`, suppressedMessages: reglas.map(ruleId => ({ ruleId })) })
    // Una, no dos: la Spec B se llevó la segunda al sustituir aquel efecto.
    const una = ['react-hooks/exhaustive-deps']

    // El inventario tiene dos entradas: la de `GroupView` y la de la salida de la
    // cáscara. Eran tres hasta que la Spec B retiró una supresión.
    const salida = informe('app/sin-conexion/page.tsx', ['@next/next/no-html-link-for-pages'])
    const igual = JSON.stringify([informe('app/g/[id]/GroupView.tsx', una), salida])
    expect(supresiones(igual)).toEqual(SUPRESIONES_DECLARADAS)

    const deMas = JSON.stringify([
      informe('app/g/[id]/GroupView.tsx', una), salida,
      informe('lib/otro.ts', ['react-hooks/exhaustive-deps']),
    ])
    expect(supresiones(deMas)).not.toEqual(SUPRESIONES_DECLARADAS)

    const deMenos = JSON.stringify([salida])
    expect(supresiones(deMenos)).not.toEqual(SUPRESIONES_DECLARADAS)

    /**
     * La que un contador dejaría pasar: **misma cuenta, otro sitio**. Tiene que
     * llevar tantos pares como el inventario declarado y diferir sólo en dónde;
     * con uno de más falla por cuenta, igual que `deMas`, y deja de distinguir un
     * multiconjunto de un contador — que es la razón por la que existe.
     *
     * Bajó a dos pares cuando el inventario bajó de dos supresiones a una, y con
     * él se quedó este caso en tres. Lo cazó la revisión de la séptima vuelta.
     */
    const movida = JSON.stringify([informe('app/page.tsx', una), salida])
    expect(supresiones(movida)).toHaveLength(SUPRESIONES_DECLARADAS.length)
    expect(supresiones(movida)).not.toEqual(SUPRESIONES_DECLARADAS)
  })
})

/**
 * Iteración 4 / R1 — la enumeración, cerrada.
 *
 * Tres vueltas encontraron tres formas de silenciar al linter desde el código:
 * el aviso visible, la supresión en línea, la directiva sin regla. La cuarta
 * —un comentario de configuración que pone una regla en `"off"`— apareció igual,
 * y dejó las tres guardas en verde: cero mensajes, cero supresiones, código 0.
 *
 * El arreglo no es el cuarto caso especial. Es darle la vuelta: **se declara lo
 * que hay, y todo lo demás sale rojo.** Una sintaxis que alguien invente mañana
 * seguirá siendo un comentario que empieza por una de estas palabras; y si no lo
 * fuera, tampoco sería configuración de eslint.
 *
 * Límite declarado (R2 de la iteración 4): esto gobierna **lo escrito en el
 * código**. No gobierna `eslint.config.mjs` —deuda 48— ni el que nadie ejecute
 * la puerta salvo una persona que la teclea —deuda 47—.
 *
 * Es un barrido de texto, no un análisis sintáctico: una directiva escrita
 * dentro de una cadena es indistinguible de una real, y una de bloque partida en
 * varias líneas se lee por su primera línea. Por eso este fichero construye las
 * suyas por concatenación — si no, se cazaría a sí mismo.
 *
 * Qué lo pone rojo (§E.3): cualquier comentario de configuración de eslint que
 * no esté en el inventario, en cualquier fichero que git conozca.
 */

/** La familia entera, de la forma más larga a la más corta. */
const PALABRAS = [
  `${DISABLE}-next-line`, `${DISABLE}-line`, DISABLE,
  `${ESL}-enable`, `${ESL}-env`, ESL,
  `${GLOB}s`, GLOB, EXPORTED,
].join('|')
/**
 * Dos formas, y no son simétricas: un `//` muere en el salto de línea, pero un
 * comentario de bloque **no**. ESLint normaliza su contenido antes de leerlo, así
 * que la palabra clave puede estar en la línea siguiente al `/*` y la honra igual.
 * Medido: con la directiva partida en dos, `pnpm lint` salía 0, el informe daba
 * 0 mensajes y 0 supresiones, y las cuatro guardas quedaban ciegas a la vez.
 */
const CONFIG = new RegExp(
  `(?://[^\\S\\n]*|/\\*\\s*)(${PALABRAS})(?![\\w-])([\\s\\S]*?)(?=\\*/|\\n|$)`,
  'g',
)

/** Lo mismo que analiza eslint. `.mts` y `.cts` incluidos: los lint, y faltaban. */
const VIGILADAS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * El inventario. Dos entradas, las dos de la Spec B, con su motivo escrito
 * encima en el fuente. Añadir una tercera obliga a escribirla aquí, que es
 * justamente el acto visible que esta guarda existe para forzar.
 */
const CONFIG_DECLARADA = [
  `app/g/[id]/GroupView.tsx ${DISABLE}-next-line react-hooks/exhaustive-deps`,
  // Spec C / iteración 5 — el motivo, junto a la otra mitad del inventario.
  `app/sin-conexion/page.tsx ${DISABLE}-next-line @next/next/no-html-link-for-pages`,
].sort()

/**
 * El canal que **no pasa por ESLint**. `eslint-plugin-react-hooks` busca esta
 * marca en cualquier comentario y hace `continue` sobre el diagnóstico en vez de
 * reportarlo: no hay mensaje, no hay supresión, ESLint no se entera. Medido: con
 * ella, un `react-hooks/rules-of-hooks` pasa de 1 error a 0 y `pnpm lint` sale 0.
 * No silencia `exhaustive-deps` — también medido, poniéndola sobre el efecto.
 *
 * A diferencia de la familia de arriba, no encabeza el comentario: va en
 * cualquier parte de él. Por eso lleva su propio patrón.
 */
const MARCA_PLUGIN = new RegExp(`\\$Flow${'FixMe'}\\[[^\\]]*\\]`, 'g')

/** Toda configuración en línea de una fuente, normalizada a «fichero texto». */
function configEnLinea(fichero: string, texto: string): string[] {
  const familia = [...texto.matchAll(CONFIG)]
    .map(m => `${fichero} ${`${m[1]}${m[2]}`.replace(/\s+/g, ' ').trim()}`)
  const plugin = [...texto.matchAll(MARCA_PLUGIN)].map(m => `${fichero} ${m[0]}`)
  return [...familia, ...plugin]
}

/** Directivas que no nombran ninguna regla antes del `--` de justificación. */
function directivasSinRegla(fichero: string, texto: string): string[] {
  const patron = new RegExp(`${DISABLE}(?:-next-line|-line)?(?![\\w-])([^*\\n]*)`, 'g')
  return texto.split('\n').flatMap((linea, i) =>
    [...linea.matchAll(patron)]
      .filter(m => !m[1].split('--')[0].replace(/\*\//g, '').trim())
      .map(() => `${fichero}:${i + 1}`))
}

/**
 * Seguidos **y** nuevos-sin-ignorar: un fichero recién creado debe salir rojo
 * antes de commitearse, no después. Un seguido ya borrado del árbol se salta:
 * `git` lo sigue listando y leerlo lanzaría `ENOENT` con un mensaje que no
 * nombra el requisito.
 */
function fuentes(): { fichero: string; texto: string }[] {
  const listado = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
  return listado.split('\0')
    .filter(f => VIGILADAS.test(f) && existsSync(f))
    .map(f => ({ fichero: f, texto: readFileSync(f, 'utf8') }))
}

const configReal = () =>
  fuentes().flatMap(({ fichero, texto }) => configEnLinea(fichero, texto)).sort()

describe('Spec A · toda configuración de eslint escrita en el código está declarada', () => {
  // DoD 3 — [REGRESIÓN], verde de partida.
  it('[REGRESIÓN] la configuración en línea del árbol es la declarada', () => {
    expect(configReal(), 'hay configuración de eslint en el código sin declarar')
      .toEqual(CONFIG_DECLARADA)
  })

  /**
   * DoD 5 — cobertura. Antes era `> 100`, que mide el tamaño del barrido y no su
   * acuerdo con el linter: un fuente en un directorio ignorado por git pero
   * analizado por eslint —`coverage/`, `test-results/`, `.vercel/`— se le
   * escapaba sin que la cifra se enterara. Ahora se compara contra la lista que
   * el propio eslint dice haber analizado.
   */
  it('el barrido mira todo lo que eslint analiza', () => {
    const r = spawnSync('npx', ['eslint', '--format', 'json'], { encoding: 'utf8' })
    const analizados = (JSON.parse(r.stdout) as InformeEslint[])
      .map(f => relative(process.cwd(), f.filePath))
      .filter(f => VIGILADAS.test(f))
    expect(analizados.length, 'el informe vino vacío').toBeGreaterThan(100)
    const barridos = new Set(fuentes().map(x => x.fichero))
    expect(analizados.filter(f => !barridos.has(f)),
      'eslint analiza ficheros que el barrido no mira').toEqual([])
  }, 60_000)

  // DoD 1 y 2 — cada forma de la familia, sembrada en un fichero real que git ve.
  it.each([
    ['configuración de una regla', `/* ${ESL} @typescript-eslint/no-unused-vars: "off" */`],
    ['disable general',            `/* ${DISABLE} */`],
    ['disable de la línea siguiente', `// ${DISABLE}-next-line no-console`],
    ['disable de esta línea',      `// ${DISABLE}-line no-console`],
    ['enable',                     `/* ${ESL}-enable no-console */`],
    ['configuración partida en dos líneas', `/*\n${ESL} @typescript-eslint/no-unused-vars: "off" */`],
    ['marca de plugin que no pasa por eslint', `// ${FLOW}[react-rule-hook]`],
    ['marca de plugin colgada al final de otra línea', `const z = 1 // vale ${FLOW}[react-rule-unsafe-ref] y ya`],
    ['global',                     `/* ${GLOB} algo */`],
    ['exported',                   `/* ${EXPORTED} algo */`],
  ])('sembrando %s, la guarda sale roja', (_nombre, directiva) => {
    const seta = '.sonda-config.ts'
    writeFileSync(seta, `${directiva}\nexport const sonda = 1\n`)
    try {
      expect(configReal(), `la guarda no vio: ${directiva}`)
        .not.toEqual(CONFIG_DECLARADA)
    } finally {
      rmSync(seta, { force: true })
    }
  })

  // Sonda del lector (§E.2): sin esto, un lector que devolviera siempre el
  // inventario declarado dejaría en verde los siete casos de arriba.
  it('el lector normaliza, ve dos directivas en una línea y no confunde a los vecinos', () => {
    expect(configEnLinea('f.ts', `  /* ${DISABLE}   no-console  */ const x = 1`))
      .toEqual([`f.ts ${DISABLE} no-console`])
    // Dos en una línea: con `match` en vez de `matchAll` sólo se veía la primera.
    expect(configEnLinea('f.ts', `/* ${DISABLE} no-console */ /* ${DISABLE} */`))
      .toEqual([`f.ts ${DISABLE} no-console`, `f.ts ${DISABLE}`])
    // La forma que dejó ciegas a las cuatro guardas: la clave en la línea
    // siguiente al `/*`. Un `//`, en cambio, sí muere en el salto.
    expect(configEnLinea('f.ts', `const a = 1 /*\n${DISABLE} no-console */`))
      .toEqual([`f.ts ${DISABLE} no-console`])
    expect(configEnLinea('f.ts', `// nada aquí\n${DISABLE}`)).toEqual([])
    // La marca del plugin: en cualquier parte del comentario, no encabezándolo.
    expect(configEnLinea('f.ts', `const z = 1 // ojo ${FLOW}[react-rule-hook] aquí`))
      .toEqual([`f.ts ${FLOW}[react-rule-hook]`])
    // Vecinos que NO son configuración.
    expect(configEnLinea('f.ts', `// ${ESL}-config-next hace esto por defecto`)).toEqual([])
    expect(configEnLinea('f.ts', `import x from "${ESL}/config"`)).toEqual([])
    expect(configEnLinea('f.ts', 'const x = 1')).toEqual([])
  })

  // La otra mitad del Caso borde 2: declarar no basta, hay que nombrar la regla.
  it('toda directiva declarada nombra la regla que silencia', () => {
    const sinRegla = CONFIG_DECLARADA
      .filter(e => e.includes(DISABLE))
      .filter(e => directivasSinRegla(e, e).length > 0)
    expect(sinRegla, 'una entrada declarada silencia el fichero entero').toEqual([])
  })

  it('el lector de reglas caza las formas sin regla y respeta la dirigida', () => {
    for (const linea of [`/* ${DISABLE} */`, `// ${DISABLE}-next-line`,
                         `// ${DISABLE}-line`, `/* ${DISABLE} -- sólo motivo */`]) {
      expect(directivasSinRegla('f.ts', linea), `no cazó: ${linea}`).toEqual(['f.ts:1'])
    }
    for (const linea of [`// ${DISABLE}-next-line react-hooks/exhaustive-deps`,
                         `// ${DISABLE}-line no-console -- sale en el arranque`,
                         `/* ${DISABLE} @typescript-eslint/no-unused-vars */`]) {
      expect(directivasSinRegla('f.ts', linea), `falso positivo: ${linea}`).toEqual([])
    }
    expect(directivasSinRegla('f.ts', `const x = 1\n\n/* ${DISABLE} */`)).toEqual(['f.ts:3'])
  })
})
