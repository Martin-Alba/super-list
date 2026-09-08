import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ficherosDeProducto } from './producto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql, pool } from './helpers'
import { borradosFisicos, borradosEnSql, RPC_DEL_PRODUCTO } from './borradoFisico'
import {
  FORMAS_PROHIBIDAS, FORMAS_LEGITIMAS, SQL_LEGITIMO, SQL_PROHIBIDO, INYECCION, MARCA_RETIRADA,
  MARCA_ANTES_DE_BORRADO_NUEVO, MARCA_EN_LA_LINEA_QUE_DENIEGA, FORMAS_INDIRECTAS, SQL_PROHIBIDO_INDIRECTO,
  PLATAFORMA_LEGITIMA, AMBITO_AMBIGUO,
} from './muestras/borrados'

/**
 * La constitución declara *hard fail* el `DELETE` físico sobre una tabla
 * publicada en `supabase_realtime`. `unit/no-physical-delete.test.ts` no lo caza
 * en el arnés: mira políticas y el token del usuario, y el arnés va por
 * `service_role`, la puerta que aquella guarda deja abierta.
 *
 * Z1 — La detección se hace sobre el **árbol**, no sobre el texto. Tres
 * versiones decidieron por patrones y cada una dejó pasar formas nuevas.
 */
let PUBLICADAS: string[] = []
let RPC_DEL_CATALOGO: string[] = []
let FUNCIONES_QUE_BORRAN: string[] = []

beforeAll(async () => {
  PUBLICADAS = (await sql<{ tabla: string }>(`
    with recursive publicadas as (
      select (schemaname || '.' || tablename)::regclass as t
      from pg_publication_tables where pubname = 'supabase_realtime'
    ),
    cascada as (
      select t from publicadas
      union
      select c.confrelid::regclass from pg_constraint c
      join cascada k on c.conrelid = k.t where c.contype = 'f' and c.confdeltype = 'c'
    )
    select distinct t::text as tabla from cascada
  `)).map(r => r.tabla)

  // AA5 — La lista blanca sale del catálogo, no de la memoria. Faltaba
  // `leave_group`, que el producto usa en `app/actions.ts`: la guarda daba rojo
  // sobre código legítimo, y una lista blanca que hace eso se acaba desactivando.
  RPC_DEL_CATALOGO = (await sql<{ nombre: string }>(`
    select p.proname as nombre from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
  `)).map(r => r.nombre)

  FUNCIONES_QUE_BORRAN = (await sql<{ nombre: string }>(`
    select p.proname as nombre from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      and p.prosrc ~* '(delete\\s+from|truncate)'
  `)).map(r => r.nombre)
})

afterAll(async () => { await pool.end() })

/**
 * Z5 — La exención es por **línea**, no por fichero. Antes eximía el fichero
 * entero: la revisión añadió un borrado real con `service_role` a uno exento y
 * la guarda siguió verde. Estas líneas intentan borrar con el token del usuario
 * para comprobar que la base lo **deniega**, y abajo se verifica que lo siguen
 * afirmando.
 */
const LINEAS_EXENTAS: Record<string, { deniega: RegExp; cuantas: number }> = {
  // `deniega` describe la línea que PUEDE eximirse: la que intenta el borrado
  // que el test afirma denegado. `cuantas` fija el presupuesto, para que una
  // exención nueva no entre sin que nadie lo note.
  'unit/no-physical-delete.test.ts': { deniega: /\.delete\(\)/, cuantas: 2 },
  'unit/grants.test.ts': { deniega: /(delete from|truncate) public\.items/, cuantas: 2 },
}

const EXCLUIDO = 'unit/muestras/'

function ficherosDelArnes(): string[] {
  const salida: string[] = []
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const ruta = join(dir, entrada)
      if (ruta.startsWith(EXCLUIDO)) continue
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue }
      if (/\.(ts|tsx|sql)$/.test(ruta)) salida.push(ruta)
    }
  }
  // AA6 — El hard fail no distingue arnés de producto: `app/`, `lib/` y
  // `proxy.ts` son justo lo que corre contra usuarios.
  recorrer('e2e'); recorrer('unit'); recorrer('supabase/migrations')
  // AG9 — el producto sale de su única definición: aquí había una cuarta copia,
  // que es la cicatriz X2 que AF8 vino a cerrar y dejó a medias.
  for (const r of ficherosDeProducto()) salida.push(r)
  salida.push('proxy.ts')
  return salida
}

const FICHEROS = ficherosDelArnes()
const revisar = (ruta: string) => {
  const fuente = readFileSync(ruta, 'utf8')
  const exencion = LINEAS_EXENTAS[ruta]
  return ruta.endsWith('.sql')
    ? borradosEnSql(fuente)
    : borradosFisicos(fuente, ruta, { activa: !!exencion, deniega: exencion?.deniega })
}

describe('Z1 el arnés no borra', () => {
  it('el conjunto publicado se lee del catálogo y explica la regla', () => {
    expect(PUBLICADAS.map(t => t.split('.').pop()))
      .toEqual(expect.arrayContaining(['items', 'group_members', 'groups', 'profiles', 'users']))
  })

  it('se revisan e2e, unit y las migraciones, y la guarda se incluye a sí misma', () => {
    expect(FICHEROS.length).toBeGreaterThan(40)
    expect(FICHEROS.some(f => f.startsWith('supabase/migrations'))).toBe(true)
    expect(FICHEROS).toContain('unit/harness-no-delete.test.ts')
    expect(FICHEROS).toContain('unit/borradoFisico.ts')
    expect(FICHEROS).toContain('proxy.ts')
    expect(FICHEROS.some(f => f.startsWith('app/'))).toBe(true)
    expect(FICHEROS.some(f => f.startsWith('lib/'))).toBe(true)
  })

  it.each(FICHEROS)('%s no borra', (f) => {
    expect(revisar(f), 'borrado físico en el arnés').toEqual([])
  })

  it.each(Object.entries(LINEAS_EXENTAS))(
    '%s: la exención cubre exactamente las líneas que deniegan', (f, { deniega, cuantas }) => {
      const fuente = readFileSync(f, 'utf8')
      expect(borradosFisicos(fuente, f).length,
        'el fichero exento ya no intenta borrar: la exención sobra').toBeGreaterThan(0)
      const marcadas = fuente.split('\n').filter(l => deniega.test(l)).length
      expect(marcadas, 'el presupuesto de líneas exentas cambió sin declararlo').toBe(cuantas)
    })

  // AA5 / DoD 97 — la lista blanca y el catálogo no pueden divergir.
  it('la lista blanca de rpc coincide con las funciones del producto', () => {
    expect([...RPC_DEL_PRODUCTO].sort(), 'la lista blanca diverge de pg_proc')
      .toEqual([...RPC_DEL_CATALOGO].sort())
  })

  /**
   * AB4 / DoD 97, 105 — La segunda cláusula del requisito no se había
   * construido. Anclar la lista al catálogo hace que toda función futura
   * concedida a `authenticated` entre sola en la blanca: sin esto, sus `rpc()`
   * pasarían sin examen aunque borraran.
   */
  it('ninguna función de la lista blanca borra por dentro', () => {
    expect(FUNCIONES_QUE_BORRAN, 'una función invocable por rpc contiene un borrado físico')
      .toEqual([])
  })

  // DoD 88 — un borrado NUEVO en un fichero exento ya no pasa: la exención es
  // por línea, y una línea nueva no está exenta.
  const EXENCION = LINEAS_EXENTAS['unit/grants.test.ts']

  it('un borrado SIN marca añadido a un fichero exento se caza igual', () => {
    const fuente = readFileSync('unit/grants.test.ts', 'utf8')
    expect(borradosFisicos(`${fuente}\n${FORMAS_PROHIBIDAS[0][1]}\n`,
      'unit/grants.test.ts', { activa: true, deniega: EXENCION.deniega }),
      'la exención sigue cubriendo el fichero entero').not.toEqual([])
  })

  /**
   * AA4 / DoD 96 — La reincidencia exacta que la revisión midió: poner la marca
   * en la línea previa a un borrado NUEVO dejaba la guarda verde. Ahora la línea
   * eximida tiene que ser ella misma la que deniega.
   */
  it('la marca delante de un borrado nuevo NO lo exime', () => {
    expect(borradosFisicos(MARCA_ANTES_DE_BORRADO_NUEVO, 'unit/grants.test.ts',
      { activa: true, deniega: EXENCION.deniega }),
      'basta un comentario para saltarse la guarda del hard fail').not.toEqual([])
  })

  it('y la línea que sí deniega queda exenta, sólo en un fichero de la lista', () => {
    expect(borradosFisicos(MARCA_EN_LA_LINEA_QUE_DENIEGA, 'unit/grants.test.ts',
      { activa: true, deniega: EXENCION.deniega })).toEqual([])
    expect(borradosFisicos(MARCA_EN_LA_LINEA_QUE_DENIEGA, 'e2e/otro.ts', { activa: false }),
      'la marca exime en un fichero que no está en la lista').not.toEqual([])
  })
})

/**
 * Z1/Z10 — Las sondas se **inyectan en ficheros reales** y se corre la guarda de
 * verdad. Y hay banco negativo: sin él, la guarda no distingue "detecta" de
 * "detecta todo", y cuatro formas legítimas se cazaban.
 */
describe('Z1 la guarda se pone roja al inyectar cada forma prohibida', () => {
  const REALES = ['e2e/global-setup.ts', 'e2e/resilience.spec.ts', 'unit/harness-no-delete.test.ts']

  it('los ficheros de inyección existen y hoy están limpios', () => {
    for (const f of REALES) expect(revisar(f), `${f} ya infringe`).toEqual([])
  })

  for (const real of REALES) {
    it.each(FORMAS_PROHIBIDAS as unknown as [string, string][])(`${real} + %s → roja`, (_n, forma) => {
      expect(borradosFisicos(`${readFileSync(real, 'utf8')}\n${forma}\n`, real), 'la forma se coló')
        .not.toEqual([])
    })
  }

  it('inyectado tras el literal de expresión regular, también', () => {
    const fuente = readFileSync('e2e/resilience.spec.ts', 'utf8')
    const i = fuente.indexOf('/\\/realtime\\/v1\\//')
    expect(i, 'el literal de regex ya no está: la sonda mira otra cosa').toBeGreaterThan(0)
    const fin = fuente.indexOf('\n', i)
    expect(borradosFisicos(fuente.slice(0, fin) + INYECCION + fuente.slice(fin), 'x.ts'),
      'el regex volvió a cegar la guarda').not.toEqual([])
  })

  // AA1 / DoD 92, 93, 94 — las puertas que quedaban abiertas por resolución
  // incompleta. Ahora se falla cerrado: lo que no se demuestra inofensivo, se marca.
  it.each(FORMAS_INDIRECTAS as unknown as [string, string][])('caza %s', (_n, forma) => {
    expect(borradosFisicos(forma), 'la resolución se detuvo y dejó pasar').not.toEqual([])
  })

  it.each(FORMAS_LEGITIMAS as unknown as [string, string][])('no confunde %s con un borrado', (_n, forma) => {
    expect(borradosFisicos(forma)).toEqual([])
  })

  // AB2 / DoD 103 — el fallo cerrado no puede dar rojo sobre la plataforma.
  it.each(PLATAFORMA_LEGITIMA as unknown as [string, string][])('no marca %s', (_n, forma) => {
    expect(borradosFisicos(forma), 'la guarda bloquea código correcto: se acabará desactivando').toEqual([])
  })

  /**
   * AB1 / DoD 102 — El ámbito era plano: bastaba reutilizar el nombre de un
   * `Set` existente para que un borrado real quedara verde, y se midió en
   * `app/g/[id]/GroupView.tsx`, que AA6 acababa de incorporar al barrido.
   */
  it('un nombre declarado dos veces deja de estar demostrado inofensivo', () => {
    expect(borradosFisicos(AMBITO_AMBIGUO), 'el ámbito plano deja pasar el borrado')
      .not.toEqual([])
  })

  it('inyectado en GroupView.tsx con el nombre de su Set, se caza', () => {
    const fuente = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')
    const contaminado = `${fuente}\nconst next = admin.from('items')\nawait next.delete()\n`
    expect(borradosFisicos(contaminado, 'app/g/[id]/GroupView.tsx'),
      'un borrado real quedó verde en un fichero de producto').not.toEqual([])
  })

  it('la marca de excepción escrita a mano ya no exime', () => {
    expect(borradosFisicos(MARCA_RETIRADA), 'la marca sigue apagando la guarda').not.toEqual([])
  })

  // DoD 87 — un fichero que no se puede analizar no es un fichero limpio.
  it('un fichero que no compila pone la guarda roja, no verde', () => {
    expect(() => borradosFisicos("/* sin cerrar\nawait admin.from('items').delete()", 'roto.ts'))
      .toThrow(/no se pudo analizar/)
  })
})

/** Z3 — el camino SQL, con su propio banco en las dos direcciones. */
describe('Z3 el SQL se lee entendiendo SQL', () => {
  it.each(SQL_PROHIBIDO as unknown as [string, string][])('caza %s', (_n, muestra) => {
    expect(borradosEnSql(muestra)).not.toEqual([])
  })

  it.each(SQL_PROHIBIDO_INDIRECTO as unknown as [string, string][])('caza %s', (_n, muestra) => {
    expect(borradosEnSql(muestra), 'la palabra grant se tragó el borrado').not.toEqual([])
  })

  it.each(SQL_LEGITIMO as unknown as [string, string][])('no confunde %s', (_n, muestra) => {
    expect(borradosEnSql(muestra)).toEqual([])
  })
})
