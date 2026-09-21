import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { funcionesExportadas, referencias, camposDelTipo } from './muertos'
import { funcionesQueSanean } from './traductor'
import { ficherosDeProducto } from './producto'
import { lecturasDeMensaje, lecturasFueraDelTraductor,
  usosIndebidosDelError, usosFueraDelTraductor, traductoresQueSanean,
  literalesDeMensaje, mensajesSueltos } from './textoCrudo'
import type { Result } from '@/lib/items'
import type { GroupPayload } from '@/lib/groupPayload'

/**
 * AD5 / DoD 111 — El invariante entero, en una frase: **el texto crudo de
 * Postgres no sale del fichero que lo traduce**. Antes de la iteración 12 había
 * cinco lecturas de `.message` fuera de él, y el crudo viajaba hasta la vista.
 */
describe('AD5 el texto crudo no sale de lib/errors.ts', () => {
  it('el barrido mira los ficheros de producto, no dos', () => {
    expect(ficherosDeProducto().length, 'el barrido se quedó corto').toBeGreaterThan(15)
  })

  /**
   * AG6 / DoD 155 — AF8 unificó la definición de «el producto» y **no dejó
   * sonda**: quitarle `proxy.ts` no ponía roja ni una prueba. Producto que no
   * vive en `app/` ni en `lib/` es justo el que se olvida.
   */
  it('la lista incluye el producto que no vive en una carpeta', () => {
    const lista = ficherosDeProducto()
    for (const suelto of readdirSync('.').filter((f: string) => /^(proxy|middleware)\.tsx?$/.test(f))) {
      expect(lista, `${suelto} corre en cada petición y quedó fuera del barrido`)
        .toContain(suelto)
    }
    expect(lista.filter(r => r.startsWith('app/')).length).toBeGreaterThan(5)
    expect(lista.filter(r => r.startsWith('lib/')).length).toBeGreaterThan(5)
  })

  /** AG7 / DoD 157 — ningún texto de usuario escrito fuera del traductor. */
  it('no hay mensajes de usuario sueltos', () => {
    expect(mensajesSueltos(),
      'este texto se le enseña a alguien y no vive en lib/errors.ts').toEqual([])
  })

  it.each([
    ['pasado a avisarTexto', "export function f() { avisarTexto('Algo salió mal.') }"],
    ['puesto en el aviso', "export function f() { setNotice({ texto: 'Algo salió mal.', clase: 'generico' }) }"],
    ['devuelto como mensaje', "export function f() { return { mensaje: 'Algo salió mal.' } }"],
  ])('y caza uno %s', (_n, forma) => {
    expect(literalesDeMensaje(forma, 'x.ts'),
      'un texto de usuario escrito fuera del traductor se coló').not.toEqual([])
  })

  it('ningún fichero de app/ ni lib/ lee .message', () => {
    expect(lecturasFueraDelTraductor(),
      'alguien volvió a sacar el texto crudo del traductor').toEqual([])
  })

  it.each([
    ['acceso directo', 'const m = error.message'],
    ['por índice', "const m = error['message']"],
    ['desestructurado', 'const { message } = error'],
    ['desestructurado con alias', 'const { message: m } = error'],
    // DoD 116 — la forma idiomática de supabase-js, invisible para la guarda de
    // contaminación porque su semilla era el nombre `error`, no el origen.
    ['sobre el resultado entero', "const res = await supabase.rpc('x'); return res.error.message"],
    ['anidado en un objeto', 'return { texto: e.error.message }'],
  ])('caza %s', (_n, forma) => {
    expect(lecturasDeMensaje(`export function f() { ${forma} }`, 'x.ts'),
      'esta lectura del crudo se coló').not.toEqual([])
  })

  it('declarar el campo en un tipo no es leerlo', () => {
    expect(lecturasDeMensaje('export type E = { message: string }', 'x.ts')).toEqual([])
    expect(lecturasDeMensaje('export function f(e: { message: string }) { return e.code }', 'x.ts'))
      .toEqual([])
  })

  // DoD 116 — la contraprueba sobre el fichero REAL: inyectada, roja.
  it('inyectada en app/actions.ts real, la guarda la ve', () => {
    const real = readFileSync('app/actions.ts', 'utf8')
    expect(lecturasDeMensaje(real, 'app/actions.ts')).toEqual([])
    expect(lecturasDeMensaje(
      `${real}\nexport function fuga() { const res = { error: { message: '' } }; return res.error.message }`,
      'app/actions.ts')).not.toEqual([])
  })
})

/**
 * AD2 / DoD 112 — Lo que hace innecesaria la guarda: el tipo. `Result` ya no
 * tiene un campo de texto, así que `avisarTexto(r.error)` —la mutación de una
 * línea que la revisión midió pintando el crudo en pantalla con 998/999 en
 * verde— no compila. Esta aserción la comprueba `pnpm typecheck`, que es parte
 * de la puerta: si alguien devuelve el campo, el proyecto entero deja de
 * compilar antes de que ningún test corra.
 */
describe('AD2 el tipo impide devolver texto', () => {
  it('Result no tiene campo de error textual', () => {
    const r: Result<number> = { data: 0, clase: null, code: null }
    // @ts-expect-error — si `error` vuelve a existir, esta línea deja de fallar
    // y `pnpm typecheck` se pone rojo. Es la guarda, no el comentario.
    const noExiste = r.error
    expect(noExiste).toBeUndefined()
  })

  it('GroupPayload tampoco', () => {
    const p = { clase: null } as unknown as GroupPayload
    // @ts-expect-error — el payload del servidor ya no lleva texto al cliente.
    const noExiste = p.error
    expect(noExiste).toBeUndefined()
  })
})

/**
 * AE3 / DoD 124-126 — La regla que cubre la promesa entera, no un campo. Un error
 * de la base sólo puede pasarse al traductor, mirarse su verdad, leerse su `code`
 * o atarse a un nombre.
 *
 * Las cuatro primeras formas las midió la revisión sobre el `app/actions.ts`
 * real: las cuatro sacaban el texto de Postgres con la puerta entera en verde, y
 * ninguna lee `.message`.
 */
describe('AE3 el error de la base sólo sirve para traducirlo', () => {
  it('ningún fichero de producto lo usa para otra cosa', () => {
    expect(usosFueraDelTraductor(),
      'alguien hizo algo con el error de la base que no es traducirlo').toEqual([])
  })

  const REAL = readFileSync('app/actions.ts', 'utf8')
  it.each([
    ['String() sobre el resultado', "export function f1() { const res: any = {}; return { mensaje: String(res.error) } }"],
    ['el campo hint', "export function f2() { const res: any = {}; return { mensaje: res.error.hint } }"],
    ['el campo details, que trae datos de otra persona',
      "export function f3() { const res: any = {}; return { mensaje: res.error.details } }"],
    ['JSON.stringify', "export function f4() { const res: any = {}; return { mensaje: JSON.stringify(res.error) } }"],
    ['plantilla', 'export function f5() { const res: any = {}; return { mensaje: `${res.error}` } }'],
    ['el error entero devuelto', "export function f6() { const res: any = {}; return { fallo: res.error } }"],
  ])('caza %s inyectada en app/actions.ts real', (_n, fuga) => {
    expect(usosIndebidosDelError(`${REAL}\n${fuga}\n`, 'app/actions.ts'),
      'esta forma sacaba el texto de Postgres con la suite en verde').not.toEqual([])
  })

  // DoD 125 — sobre el fichero donde el crudo se CAPTURA, que no tenía guarda.
  it('caza String(e) en el catch de GroupView.tsx real', () => {
    const vista = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')
    expect(usosIndebidosDelError(vista, 'GroupView.tsx')).toEqual([])
    expect(usosIndebidosDelError(
      // AF1 — El parámetro se llama `e`, que es el nombre que el DoD escribe.
      // La versión anterior lo llamaba `error`, o sea RENOMBRABA la variable a la
      // semilla de la guarda: pasaba por construcción, y con `e` la guarda
      // devolvía `[]` en 21 de los 22 ficheros.
      vista.replace(".then(r => {", ".catch((e: unknown) => avisarTexto(String(e))).then(r => {"),
      'GroupView.tsx'), 'la mutación que pintaba PostgrestError en pantalla se coló')
      .not.toEqual([])
  })

  /**
   * AF1 / DoD 136 — El error llega por posición: el rechazo de una promesa y la
   * variable de un `catch`. Se prueban con nombres que no son la semilla, que es
   * el punto entero.
   */
  it.each([
    ['catch de promesa', 'export function f() { p.catch((e: any) => enviar(String(e))) }'],
    ['catch con otro nombre', 'export function f() { p.catch((fallo: any) => enviar(fallo.details)) }'],
    ['segundo argumento de then', 'export function f() { p.then(ok, (x: any) => enviar(x.hint)) }'],
    ['catch de bloque', 'export function f() { try { z() } catch (problema) { enviar(String(problema)) } }'],
    ['catch desestructurado', 'export function f() { p.catch(({ message: m }: any) => enviar(m)) }'],
  ])('caza %s', (_n, forma) => {
    expect(usosIndebidosDelError(forma, 'x.ts'),
      'el error llegó por el rechazo y la guarda miró el nombre').not.toEqual([])
  })

  /**
   * AF6 / DoD 143 — Los cuatro usos que la regla DECLARA legítimos. La revisión
   * midió que dos se marcaban: la guarda castigaba la forma limpia, que es la
   * cicatriz AD7 —empujar a escribir la sucia— repetida.
   */
  it.each([
    ['destructurar el código', 'export function f() { const { code } = error; return { code } }'],
    ['Boolean()', "export function f() { const hay = Boolean(error); return { hay } }"],
    ['doble negación', 'export function f() { const hay = !!error; return { hay } }'],
    ['comparar el código', "export function f() { if (error.code === '23505') return { d: true }\n  return {} }"],
  ])('y NO marca %s', (_n, limpio) => {
    expect(usosIndebidosDelError(limpio, 'x.ts'),
      'la guarda castiga la forma limpia: eso empuja a escribir la sucia').toEqual([])
  })

  /**
   * AF9 / DoD 146 — La exención del código miraba el nombre del campo y no de
   * quién se leía, así que `error.details.code` la usaba para **lavar
   * `details`**: el código de dentro salvaba al campo de fuera.
   */
  it.each([
    ['details.code', 'export function f() { return { m: error.details.code } }'],
    ['hint.code', 'export function f() { return { m: error.hint.code } }'],
    ["índice con 'code'", "export function f() { return { m: error.details['code'] } }"],
  ])('leer el código DENTRO de otro campo no lava: %s', (_n, forma) => {
    expect(usosIndebidosDelError(forma, 'x.ts'),
      'el código de dentro lavó el campo de fuera').not.toEqual([])
  })

  it.each([
    ['pasarlo al traductor', "import { claseDe } from '@/lib/errors'\nexport function ok1() { const res: any = {}; return { clase: claseDe(res.error) } }"],
    ['mirar su verdad', "export function ok2() { const res: any = {}; if (res.error) return { clase: 'red' }\n  return {} }"],
    ['leer su código', "export function ok3() { const res: any = {}; return { code: res.error?.code ?? null } }"],
    ['atarlo a un nombre y traducirlo',
      "import { claseDe } from '@/lib/errors'\nexport function ok4() { const { error } = { error: null } as any\n  return { clase: claseDe(error) } }"],
  ])('y deja pasar %s', (_n, limpio) => {
    expect(usosIndebidosDelError(limpio, 'x.ts'),
      'la guarda marca la forma legítima: entonces no se puede cumplir').toEqual([])
  })
})

/**
 * AE6 / DoD 131 — El código muerto se defiende solo: `describeError` llevaba dos
 * iteraciones sin que ningún fichero de producto lo llamara, y lo único que lo
 * mantenía vivo eran sus propios tests. Lo mismo `GroupPayload.errorCode`,
 * sostenido por un `toMatch(/errorCode/)` sobre el fuente.
 *
 * La regla: una función exportada del traductor la llama alguien —producto, o el
 * propio módulo— o no es una función exportada. Las constantes de texto quedan
 * fuera a propósito: nombrar el mensaje esperado en un test es un uso legítimo.
 */
describe('AE6 el traductor no exporta funciones que no llama nadie', () => {
  const FUENTE = readFileSync('lib/errors.ts', 'utf8')
  const referenciasDe = (rutas: string[]) => {
    const todas = new Set<string>()
    for (const r of rutas) for (const n of referencias(readFileSync(r, 'utf8'), r)) todas.add(n)
    return todas
  }
  const enProducto = referenciasDe(ficherosDeProducto().filter(r => r !== 'lib/errors.ts'))
  const dentroDelModulo = referencias(FUENTE, 'lib/errors.ts')

  const vivas = (fuente: string, referencias0: Set<string>, propias: Set<string>) =>
    funcionesExportadas(fuente, 'lib/errors.ts')
      .filter(f => !referencias0.has(f) && !propias.has(f))

  it('se reconocen las funciones exportadas, con anotación de tipo o sin ella', () => {
    expect(funcionesExportadas(FUENTE, 'lib/errors.ts').length).toBeGreaterThan(3)
    expect(funcionesExportadas(
      'export const f: (x: number) => number = (x) => x', 'm.ts'),
      'la anotación de tipo la hacía invisible al censo').toEqual(['f'])
  })

  it('ninguna función exportada del traductor está muerta', () => {
    expect(vivas(FUENTE, enProducto, dentroDelModulo),
      'estas funciones no las llama ni el producto ni el propio módulo').toEqual([])
  })

  /**
   * AF4 / DoD 141 — La sonda que §E.2 exige. Se siembran funciones muertas en
   * las seis formas que la revisión midió; tres sobrevivían a la versión de
   * expresión regular.
   */
  it.each([
    ['declarada', 'export function zz1() { return 1 }'],
    ['flecha', 'export const zz2 = () => 1'],
    ['flecha con anotación', 'export const zz3: () => number = () => 1'],
    ['citada en un comentario de línea', 'export function zz4() { return 1 }'],
    ['citada en un bloque', 'export function zz5() { return 1 }'],
    ['asíncrona', 'export async function zz6() { return 1 }'],
  ])('una función muerta %s se caza', (etiqueta, declaracion) => {
    const cita = etiqueta.includes('línea') ? '// zz4() explica algo\n'
      : etiqueta.includes('bloque') ? '/** zz5() explica algo */\n' : ''
    const nombre = /zz\d/.exec(declaracion)![0]
    // La cita va en el PRODUCTO, que es donde la versión anterior la contaba.
    const conCita = new Set([...enProducto, ...referencias(cita || '// nada', 'p.ts')])
    expect(vivas(`${FUENTE}\n${declaracion}\n`, conCita, dentroDelModulo),
      `${nombre} muerta se coló: una cita en un comentario no es una llamada`)
      .toContain(nombre)
  })

  it('el payload no lleva campos que nadie lee', () => {
    const consumidores = referenciasDe(ficherosDeProducto()
      .filter(r => r !== 'lib/groupPayload.ts' && r !== 'lib/errors.ts'))
    const tipo = readFileSync('lib/groupPayload.ts', 'utf8')
    const campos = camposDelTipo(tipo, 'GroupPayload', 'lib/groupPayload.ts')
    expect(campos.length, 'no se reconoció ningún campo').toBeGreaterThan(3)
    for (const campo of campos) {
      expect(consumidores.has(campo),
        `GroupPayload.${campo} viaja en el payload de Flight y no lo lee nadie`).toBe(true)
    }
  })

  // DoD 141 — y su sonda: un campo muerto sembrado tiene que caer.
  it.each(['zzMuerto', 'clase2', 'errorCode'])('un campo muerto %s se caza', (campo) => {
    const consumidores = referenciasDe(ficherosDeProducto()
      .filter(r => r !== 'lib/groupPayload.ts' && r !== 'lib/errors.ts'))
    const tipo = readFileSync('lib/groupPayload.ts', 'utf8')
      .replace('  clase: Clase | null', `  ${campo}: string | null\n  clase: Clase | null`)
    const campos = camposDelTipo(tipo, 'GroupPayload', 'lib/groupPayload.ts')
    expect(campos, 'el campo sembrado no se censó').toContain(campo)
    expect(consumidores.has(campo), `${campo} muerto se coló`).toBe(false)
  })
})

/**
 * AG2 / DoD 149-150 — La exención se gana. `refinarSinSesion` está exportada por
 * el traductor y **devuelve su propio argumento** para seis de las siete clases,
 * así que envolver el crudo en ella lo limpiaba a ojos de la guarda; y bastaba
 * que el nombre del método coincidiera para que `o.mensajeDe(...)` hiciera lo
 * mismo. Ahora se calcula qué funciones sanean de verdad, leyendo el traductor.
 */
describe('AG2 sólo exime lo que sanea', () => {
  const sanean = traductoresQueSanean()

  it('el cálculo distingue las que sanean de las que devuelven su argumento', () => {
    expect([...sanean].sort()).toContain('claseDe')
    expect([...sanean].sort()).toContain('mensajeDe')
    expect(sanean.has('refinarSinSesion'),
      'refinarSinSesion devuelve su argumento: no puede eximir nada').toBe(false)
  })

  it.each([
    ['envuelto en una función que devuelve su argumento',
      "import { refinarSinSesion } from '@/lib/errors'\nexport function f() { const res: any = {}\n  return { mensaje: refinarSinSesion(String(res.error)) } }"],
    ['un método que se llama igual que un traductor',
      "import { mensajeDe } from '@/lib/errors'\nexport function f() { const o: any = {}, res: any = {}\n  return { mensaje: o.mensajeDe(res.error.hint) } }"],
    ['un método homónimo de claseDe',
      "import { claseDe } from '@/lib/errors'\nexport function f() { const o: any = {}, res: any = {}\n  return { mensaje: o.claseDe(res.error) } }"],
  ])('caza el crudo %s', (_n, forma) => {
    expect(usosIndebidosDelError(forma, 'x.ts'),
      'esta envoltura limpiaba el crudo sin sanear nada').not.toEqual([])
  })

  it('y el traductor de verdad sigue eximiendo', () => {
    expect(usosIndebidosDelError(
      "import { claseDe } from '@/lib/errors'\nexport function ok() { const res: any = {}\n  return { clase: claseDe(res.error) } }", 'x.ts')).toEqual([])
  })
})

/**
 * AG1 / DoD 147-148 — Las cinco formas de lavar el crudo llamando `code` al campo
 * donde se guarda. La revisión las midió sobre `app/actions.ts` real: el texto de
 * Postgres llegaba hasta `CreateGroupForm`, que lo pinta, con `typecheck`, `lint`
 * y 1093/1093 en verde. La causa era mía: AF9 arregló el lavado en `soloSeMira` y
 * dejó el corte de `contamina` ciego al receptor.
 */
describe('AG1 llamar code a un campo no lo lava', () => {
  const REAL = readFileSync('app/actions.ts', 'utf8')
  it.each([
    /**
     * AH1 — Y el receptor del `.error` tampoco puede estar sucio: `x.error` sólo
     * es el error de la base si `x` está limpio. Con la versión anterior,
     * `const w = { error: { code: JSON.stringify(error) } }` leído como
     * `w.error.code` sacaba el JSON entero de PostgREST a la pantalla.
     */
    ['envoltura con campo error', 'export function w1() { const w: any = { error: { code: JSON.stringify(error) } }\n  return { mensaje: w.error.code } }'],
    ['envoltorio por asignación', 'export function w2() { const w: any = {}; w.error = { code: String(error) }\n  return { mensaje: w.error.code } }'],
    ['fábrica de envoltorios', 'export function w3() { const mk = (e: any) => ({ error: { code: String(e) } })\n  return { mensaje: mk(error).error.code } }'],
    ['envoltura por corchetes', "export function w4() { const w: any = { error: { code: String(error) } }\n  return { mensaje: w['error']['code'] } }"],
    ['alias del campo envuelto', 'export function w5() { const w: any = { error: { code: String(error) } }; const q = w.error\n  return { mensaje: q.code } }'],
    ['campo llamado code', 'export function h1() { const b: any = { code: String(error) }\n  return { mensaje: b.code } }'],
    ['code por índice', "export function h2() { const b: any = { code: String(error) }\n  return { mensaje: b['code'] } }"],
    ['code dentro de otro campo', 'export function h3() { return { mensaje: error.details.code } }'],
    ['objeto devuelto con code', 'export function h4() { return { code: `${error}` } }'],
    ['asignado y releído', 'export function h5() { const b: any = {}; b.code = error.hint\n  return { mensaje: b.code } }'],
  ])('caza %s inyectada en app/actions.ts real', (_n, fuga) => {
    /**
     * Se afirma la LÍNEA de la fuga, no que la lista no esté vacía. Medido: con
     * la versión ciega restaurada, la lista seguía sin estar vacía por hallazgos
     * de otras líneas del fragmento, así que estas cinco aserciones pasaban
     * pasara lo que pasara con la forma que prueban. Es el defecto que llevo
     * siete rondas persiguiendo, cometido otra vez y cazado antes de cerrar.
     */
    const fuente = `${REAL}\n${fuga}\n`
    const linea = REAL.split('\n').length + fuga.split('\n').length
    const hallazgos = usosIndebidosDelError(fuente, 'app/actions.ts')
    expect(hallazgos.some(h => h.endsWith(`(línea ${linea})`)),
      `llamar code al campo lavaba el crudo — hallazgos: ${hallazgos.join(', ') || 'ninguno'}`)
      .toBe(true)
  })

  // El control que hace que las cinco puedan fallar: sin inyectar, limpio.
  it('y el fichero real, sin inyectar nada, está limpio', () => {
    expect(usosIndebidosDelError(REAL, 'app/actions.ts')).toEqual([])
  })

  it.each([
    ['error.code', "export function ok1() { const res: any = {}; return { code: res.error?.code ?? null } }"],
    ["error['code']", "export function ok2() { const res: any = {}; return { code: res.error['code'] ?? null } }"],
    ['el código comparado', "export function ok3() { const res: any = {}\n  if (res.error['code'] === '23505') return { d: true }\n  return {} }"],
  ])('y NO marca %s, que es la lectura legítima', (_n, limpio) => {
    expect(usosIndebidosDelError(limpio, 'x.ts'),
      'la guarda castiga la lectura que la regla declara legítima').toEqual([])
  })
})

/**
 * AG3 / DoD 151 — La semilla marcaba **cualquier** `.error`, así que
 * `console.error('algo')` —que no toca ningún error de la base— se reportaba como
 * fuga. Una guarda que castiga registrar empuja a no registrar, o a registrar
 * peor. La política está escrita en el checkpoint (AG8): el código sí, el error
 * entero no.
 */
describe('AG3 registrar no es filtrar, pero registrar el error sí', () => {
  it.each([
    ['un texto', "export function f() { console.error('la carga falló') }"],
    ['el código', "export function f() { const res: any = {}; console.error('falló', res.error?.code) }"],
    ['la clase', "export function f() { const r: any = {}; console.error('falló', r.clase) }"],
  ])('no marca registrar %s', (_n, forma) => {
    expect(usosIndebidosDelError(forma, 'x.ts'),
      'la guarda castigaba un registro que no toca ningún error').toEqual([])
  })

  it.each([
    ['el error entero', "export function f() { const res: any = {}; console.error('falló', res.error) }"],
    ['su mensaje', "export function f() { const res: any = {}; console.error(String(res.error)) }"],
    ['sus details', "export function f() { const res: any = {}; console.warn(res.error.details) }"],
  ])('y sí marca registrar %s', (_n, forma) => {
    expect(usosIndebidosDelError(forma, 'x.ts'),
      'registrar el error copia datos de otro usuario a otro sitio').not.toEqual([])
  })
})

/**
 * AH5 / DoD 163-164 — Los avisos escritos directamente en el JSX. La guarda de
 * AG7 sólo veía lo que pasa por `avisarTexto`/`setNotice`, así que dos avisos de
 * canal degradado vivían en las vistas, con redacciones distintas, sin que nada
 * los mirara. Siguen diciendo cosas distintas a propósito — pero desde el
 * traductor, donde se pueden leer juntas.
 *
 * El límite está declarado: se mira el texto de lo que **anuncia**
 * (`role="status"`, `role="alert"`), no la copia de la página. Un titular no es
 * un aviso.
 */
describe('AH5 los avisos escritos en el JSX también cuentan', () => {
  it.each([
    ['un aviso de estado', '<p role="status">Sin conexión en vivo.</p>'],
    ['un aviso de error', '<p role="alert">Algo salió mal.</p>'],
    ['con atributos alrededor', '<p data-testid="x" role="status" className="y">Se perdió el canal.</p>'],
    // AI5 — nueve formas vecinas que la versión anterior dejaba pasar.
    ['una expresión con literal', "<p role=\"status\">{'Sin conexión.'}</p>"],
    ['una plantilla', '<p role="status">{`Sin conexión.`}</p>'],
    ['texto anidado', '<div role="alert"><p>Sin conexión.</p></div>'],
    ['aria-live sin role', '<p aria-live="polite">Sin conexión.</p>'],
    ['role en expresión', "<p role={'alert'}>Sin conexión.</p>"],
    ['dentro de un fragmento', '<div role="status"><>Sin conexión.</></div>'],
    ['repartido entre hermanos', '<div role="status"><span>Sin</span><span>conexión.</span></div>'],
    ['un ternario entre literales', "<p role=\"status\">{x ? 'Sin conexión.' : 'Con conexión.'}</p>"],
    ['el aria-label de un anunciador', '<p role="alert" aria-label="Fallo grave" />'],
  ])('caza %s', (_n, jsx) => {
    expect(literalesDeMensaje(`export const V = () => (${jsx})`, 'v.tsx'),
      'un aviso escrito a mano en el JSX se coló').not.toEqual([])
  })

  it.each([
    ['un titular', '<h1>Esperando aprobación</h1>'],
    ['un párrafo de la página', '<p className="x">Ya has pedido entrar.</p>'],
    ['un aviso que viene del traductor', '<p role="status">{SIN_CONEXION_LISTA}</p>'],
    // El límite, declarado: la etiqueta de un campo es copia de la interfaz, no
    // un mensaje, y llevarla al traductor de errores mezclaría dos cosas.
    ['la etiqueta de un campo', '<input aria-label="Nombre" />'],
    ['el título de la página', '<h1 className="x">Mis grupos</h1>'],
  ])('y no marca %s', (_n, jsx) => {
    expect(literalesDeMensaje(`export const V = () => (${jsx})`, 'v.tsx')).toEqual([])
  })

  it('los dos avisos de canal viven en el traductor', () => {
    const traductor = readFileSync('lib/errors.ts', 'utf8')
    for (const nombre of ['SIN_CONEXION_LISTA', 'SIN_CONEXION_ESPERA', 'LISTA_EN_VIVO']) {
      expect(traductor, `${nombre} no está donde vive el texto`).toContain(`export const ${nombre} =`)
    }
  })
})

/**
 * AH6 / DoD 165 — El cálculo de saneamiento filtraba los parámetros
 * desestructurados y luego tomaba «sin parámetros» por «no puede ensuciar». Basta
 * añadir un ayudante así al traductor para reabrir el lavado que AG2 cerró.
 */
describe('AH6 el cálculo cuenta los parámetros desestructurados', () => {
  it.each([
    ['objeto', 'export function envolver({ x }: any) { return x }'],
    ['array', 'export function envolver([x]: any) { return x }'],
    ['anidado', 'export function envolver({ a: { x } }: any) { return x }'],
  ])('una función que devuelve su argumento %s no sanea', (_n, decl) => {
    const traductor = `${readFileSync('lib/errors.ts', 'utf8')}\n${decl}\n`
    expect([...funcionesQueSanean(traductor, 'lib/errors.ts')],
      'devuelve su argumento y aun así eximía').not.toContain('envolver')
  })

  it('y una que de verdad sanea, sí', () => {
    const traductor = `${readFileSync('lib/errors.ts', 'utf8')}\nexport function fija({ x }: any) { return x ? 'sí' : 'no' }\n`
    expect([...funcionesQueSanean(traductor, 'lib/errors.ts')]).toContain('fija')
  })
})

/**
 * AI1 / DoD 168-170 — **El origen.** Tres iteraciones cerraron el envoltorio del
 * error y ninguna cerró el objeto que lo trae: `const res = await supabase.rpc(…)`
 * dejaba `res` limpio, y `res` contiene `error.message`, `error.details` y
 * `error.hint`. La diferencia entre la forma segura y la fuga era una línea:
 * destructurar o no destructurar.
 */
describe('AI1 el resultado del cliente lleva el error dentro', () => {
  const REAL = readFileSync('app/actions.ts', 'utf8')
  it.each([
    ['JSON.stringify del resultado', "export async function z1() { const res = await sb.rpc('x')\n  return { mensaje: JSON.stringify(res) } }"],
    ['spread del resultado', "export async function z2() { const res = await sb.rpc('x')\n  return { ...res } }"],
    ['registrarlo entero', "export async function z3() { const res = await sb.rpc('x')\n  console.error('falló', res) }"],
    ['structuredClone', "export async function z4() { const res = await sb.rpc('x')\n  return { m: structuredClone(res) } }"],
    ['Object.entries', "export async function z5() { const res = await sb.rpc('x')\n  return { m: Object.entries(res) } }"],
    ['el resto de la desestructuración', "export async function z6() { const { data, ...resto } = await sb.rpc('x')\n  return { m: resto } }"],
    ['la cadena entera sin destructurar', "export async function z7() { const r = await sb.from('t').select('*').eq('a', 1)\n  return { mensaje: `${r}` } }"],
  ])('caza %s inyectada en app/actions.ts real', (_n, fuga) => {
    const fuente = `${REAL}\n${fuga}\n`
    const linea = REAL.split('\n').length + fuga.split('\n').length
    const hallazgos = usosIndebidosDelError(fuente, 'app/actions.ts')
    expect(hallazgos.some(h => h.endsWith(`(línea ${linea})`)),
      `el resultado sin destructurar sacaba el crudo — hallazgos: ${hallazgos.join(', ') || 'ninguno'}`)
      .toBe(true)
  })

  /**
   * DoD 169-170 — Y de un resultado sólo salen limpios los campos que no son el
   * error. `return { token: data }` es la forma que `createInviteAction` usa hoy:
   * si la guarda la marcara, la regla sería incumplible.
   */
  it.each([
    ['data', "export async function ok1() { const res = await sb.rpc('x')\n  return { token: res.data } }"],
    ['count y status', "export async function ok2() { const res = await sb.rpc('x')\n  return { n: res.count, s: res.status } }"],
    ['data destructurado', "export async function ok3() { const { data } = await sb.rpc('x')\n  return { token: data } }"],
    ['el error, mirado y traducido', "import { claseDe } from '@/lib/errors'\nexport async function ok4() { const { data, error } = await sb.rpc('x')\n  if (error) return { clase: claseDe(error) }\n  return { token: data } }"],
    ['la consulta disparada y descartada', "export function ok5() { void sb.from('t').update({ a: 1 }).eq('b', 2) }"],
  ])('y NO marca %s', (_n, limpio) => {
    expect(usosIndebidosDelError(limpio, 'x.ts'),
      'la guarda marca la forma que el producto usa hoy: la regla sería incumplible').toEqual([])
  })

  it('el resto de la desestructuración se mancha y `data` no', () => {
    const conResto = "export async function f() { const { data, ...resto } = await sb.rpc('x')\n  return { m: resto } }"
    const soloData = "export async function f() { const { data, ...resto } = await sb.rpc('x')\n  return { m: data } }"
    expect(usosIndebidosDelError(conResto, 'x.ts'), 'el resto lleva el error dentro').not.toEqual([])
    expect(usosIndebidosDelError(soloData, 'x.ts'), '`data` no lleva nada del error').toEqual([])
  })
})

/**
 * AJ1-AJ2 — **Corrección de la iteración 17, no una iteración nueva.**
 *
 * Sembrar el origen dejó la cadena entera del cliente contaminada, y la regla de
 * «expresión máxima» subía hasta el nodo más externo: una exención de fuera —el
 * descarte de `void chain`, la atadura a un nombre— tapaba todo lo que hubiera
 * dentro, **incluido el cuerpo de un callback**, que es otro ámbito. Medido sobre
 * `GroupView.tsx` real: una fuga dentro del `.then(…)` devolvía `[]`, y con la
 * semilla anterior a la 17 se cazaba. Cada cuerpo de función es su propia raíz.
 *
 * Y «receptor limpio» se volvió imposible de cumplir: un resultado del cliente
 * está sucio por definición, así que `res.error?.code` —la lectura que S14
 * declara legítima y que la política de registro permite— se marcaba como fuga.
 */
describe('AJ1 lo que pasa dentro de un callback se juzga dentro', () => {
  const vista = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')

  it.each([
    ['dentro del .then de una consulta descartada',
      vista.replace('.then(({ data }) => {', '.then(({ data, error }: any) => {\n          if (error) avisarTexto(String(error))')],
    ['dentro de un catch encadenado',
      vista.replace('.then(({ data }) => {', '.catch((e: any) => avisarTexto(e.details)).then(({ data }) => {')],
  ])('caza la fuga %s', (_n, mutante) => {
    expect(usosIndebidosDelError(mutante, 'GroupView.tsx'),
      'la exención del nodo de fuera tapaba el cuerpo del callback').not.toEqual([])
  })

  it('y el fichero real, sin mutar, sigue limpio', () => {
    expect(usosIndebidosDelError(vista, 'GroupView.tsx')).toEqual([])
  })
})

describe('AJ2 el receptor que ES el resultado sigue siendo el error', () => {
  it.each([
    ['leer el código del error', "export async function ok() { const res = await sb.rpc('x')\n  return { code: res.error?.code ?? null } }"],
    ['registrar sólo el código', "export async function ok() { const res = await sb.rpc('x')\n  console.error('falló', res.error?.code) }"],
    ['Array.from, que no es la biblioteca', 'export function ok() { const m = new Map(); return { l: Array.from(m) } }'],
    ['un ayudante propio', 'export async function ok() { const r = await miHelper(); return { token: r.data } }'],
  ])('no marca %s', (_n, limpio) => {
    expect(usosIndebidosDelError(limpio, 'x.ts'),
      'la guarda contradecía la política de registro que el checkpoint declara').toEqual([])
  })

  it('pero sí el error entero registrado', () => {
    expect(usosIndebidosDelError(
      "export async function f() { const res = await sb.rpc('x')\n  console.error('falló', res.error) }", 'x.ts'))
      .not.toEqual([])
  })
})
