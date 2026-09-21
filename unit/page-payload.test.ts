import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { newUser, newGroup } from './helpers'
import { loadGroupPayload } from '../lib/groupPayload'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * J5 / DoD 40 — la versión anterior de este test reejecutaba una *copia* de la
 * consulta: si la página volviera al `select` suelto de `profiles`, seguiría
 * verde. Ahora llama a la misma función que llama la página, y además
 * comprueba que la página sigue delegando en ella.
 */
describe('J5 el payload de la página no lleva a nadie de fuera del grupo', () => {
  it('la página delega en loadGroupPayload', () => {
    const src = readFileSync('app/g/[id]/page.tsx', 'utf8')
    expect(src).toContain('loadGroupPayload')
    // Control positivo: el patrón detecta la vuelta atrás.
    expect(src).not.toMatch(/from\('profiles'\)/)
  })

  it('sólo viajan los perfiles de los miembros de ese grupo', async () => {
    const owner = await newUser('pl-owner')
    const other = await newUser('pl-other')
    const gidA = await newGroup(owner, 'Grupo A')
    const gidB = await newGroup(owner, 'Grupo B')

    // `other` sólo entra en B: comparte grupo con el owner, pero no el A.
    const { data: tokenB } = await owner.client.rpc('create_invite', { p_group_id: gidB })
    await other.client.rpc('request_join', { p_token: tokenB })
    await owner.client.rpc('decide_member', { p_group_id: gidB, p_user_id: other.id, p_decision: 'active' })

    const payload = await loadGroupPayload(owner.client, gidA)

    expect(payload.group?.name).toBe('Grupo A')
    expect(payload.members.map(m => m.user_id)).toEqual([owner.id])
    expect(payload.profiles.map(p => p.id)).toEqual([owner.id])
    expect(JSON.stringify(payload), 'un no-miembro viajó en el payload').not.toContain(other.id)
  })

  it('en el grupo compartido sí viajan los dos, con nombre', async () => {
    const owner = await newUser('pl-owner2')
    const member = await newUser('pl-member2')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    await member.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: member.id, p_decision: 'active' })

    const payload = await loadGroupPayload(owner.client, gid)
    expect(payload.profiles.map(p => p.id).sort()).toEqual([owner.id, member.id].sort())
    expect(payload.profiles.every(p => p.display_name)).toBe(true)
  })
})

describe('K3 un fallo de consulta no se lee como "no hay nadie"', () => {
  it('con la red caída, el payload lo dice en vez de devolver listas vacías', async () => {
    // Cliente REAL de supabase-js con la red rota: es el modo de avería que la
    // cota de `boundedFetch` produce cuando el upstream no responde. No se
    // simula la biblioteca, sólo se le quita la red.
    const roto = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false }, global: { fetch: () => Promise.reject(new Error('network aborted')) } },
    )

    const payload = await loadGroupPayload(roto, '00000000-0000-4000-8000-000000000000')
    expect(payload.clase, 'el fallo se perdió y quedó como lista vacía').toBeTruthy()
    expect(payload.members).toEqual([])
    expect(payload.items).toEqual([])
  })

  // L3 / DoD 65 — antes los dos casos daban `group: null` y la pagina
  // respondia 404: a un miembro legitimo se le decia que su grupo no existe
  // por una caida pasajera.
  it('un fallo del grupo se distingue de un grupo que no existe', async () => {
    const roto = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false }, global: { fetch: () => Promise.reject(new Error('network aborted')) } },
    )
    const averiado = await loadGroupPayload(roto, '00000000-0000-4000-8000-000000000000')

    const owner = await newUser('pg-owner')
    await newGroup(owner)
    const inexistente = await loadGroupPayload(owner.client, '00000000-0000-4000-8000-000000000000')

    expect(averiado.group).toBeNull()
    expect(inexistente.group).toBeNull()
    // Mismo `group`, distinta `clase`: eso es lo que la pagina necesita para
    // no responder 404 ante una averia.
    expect(averiado.clase).toBeTruthy()
    expect(inexistente.clase).toBeNull()
  })

  it('sin avería, el error es nulo', async () => {
    const owner = await newUser('pe-owner')
    const gid = await newGroup(owner)
    const payload = await loadGroupPayload(owner.client, gid)
    expect(payload.clase).toBeNull()
  })
})

/**
 * S10 / DoD 27 — `loadGroupPayload` es la única vía que pinta un error de
 * servidor, y devolvía sólo el texto: R1 quedaba instalada a medias, porque esa
 * pantalla seguía decidiendo por el mensaje.
 */
describe('S10 el error de carga viaja con su código', () => {
  /**
   * AG6 — Aquí había «el payload declara errorCode», con un `toMatch(/errorCode/)`
   * sobre el fuente. AE6 **borró ese campo**, y lo único que seguía satisfaciendo
   * la aserción era el comentario que explica el borrado: el defecto que AF4 vino
   * a cerrar —una cita en un comentario contando como uso— vivo en otro fichero,
   * y contradiciendo al test que siembra `errorCode` como campo muerto.
   */

  /**
   * V5 — Esto era `toMatch` sobre el texto, y se colaban `loadError={ error }`,
   * un cast, un salto de línea y una variable intermedia. Es el mismo instrumento
   * que U8 acababa de retirar de la guarda de migraciones, en el mismo diff. Se
   * mira el árbol: qué expresión concreta se le pasa al atributo.
   */
  it('la página no pasa el texto crudo al cliente', () => {
    expect(pasaCrudoAlCliente(readFileSync('app/g/[id]/page.tsx', 'utf8'), 'page.tsx')).toBe(false)
  })

  it.each([
    ['directo', 'const x = <V loadError={error} />'],
    ['con espacios', 'const x = <V loadError={ error } />'],
    ['con cast', 'const x = <V loadError={error as string} />'],
    ['por variable intermedia', 'const crudo = error; const x = <V loadError={crudo} />'],
    // W3 / DoD 64, 65 — las ocho que se colaban. La primera es la regresión real:
    // revertir la página a esto reintroduce la fuga y el test pasaba igual.
    ['ternario, la regresión real', 'const a = error ? error : null; const x = <V loadError={a} />'],
    ['coalescencia', 'const a = error ?? null; const x = <V loadError={a} />'],
    ['plantilla', 'const a = `${error}`; const x = <V loadError={a} />'],
    ['String()', 'const a = String(error); const x = <V loadError={a} />'],
    ['mensaje', 'const x = <V loadError={error.message} />'],
    ['concatenación', 'const x = <V loadError={"x" + error} />'],
    ['spread de props', 'const p = { loadError: error }; const x = <V {...p} />'],
    ['cadena de variables', 'const a = error; const b = a; const x = <V loadError={b} />'],
    // X2 / DoD 70 — las cuatro que le faltaban a la copia. La primera es la
    // forma que usa `app/g/[id]/page.tsx` hoy mismo.
    ['desestructurado con alias', 'const { error: crudo } = p; const x = <V loadError={crudo} />'],
    ['capturado', 'let a; try { f() } catch (e) { a = e } const x = <V loadError={a} />'],
    ['asignado después', 'let a; a = error; const x = <V loadError={a} />'],
    ['toString', 'const x = <V loadError={error.toString()} />'],
    // Y6 / DoD 80 — las ocho que se le colaban a esta guarda y la hermana sí
    // cazaba: compartían el motor y no la decisión.
    ['Object.assign', 'const d = {}; Object.assign(d, error); const x = <V loadError={d} />'],
    ['getter', 'const o = { get e() { return error } }; const x = <V loadError={o.e} />'],
    ['destructuring de array', 'const [a] = [error]; const x = <V loadError={a} />'],
    ['for...of', 'let a; for (const e of [error]) { a = e } const x = <V loadError={a} />'],
    ['campo de clase', 'class C { e = error }; const c = new C(); const x = <V loadError={c.e} />'],
    ['parámetro por defecto', 'function f(e = error) { return e }; const x = <V loadError={f()} />'],
    ['función que lo devuelve', 'function f() { return error }; const x = <V loadError={f()} />'],
    ['función flecha que lo devuelve', 'const f = () => error; const x = <V loadError={f()} />'],
  ])('la guarda caza %s', (_n, fuente) => {
    expect(pasaCrudoAlCliente(fuente)).toBe(true)
  })

  it('y no marca el traducido', () => {
    // Con su import, como el fichero real. AG2 — y la exención ya no es «venir
    // del módulo»: es sanear. `claseDe` sanea, `refinarSinSesion` no.
    expect(pasaCrudoAlCliente(`import { claseDe } from '@/lib/errors'
const a = claseDe(error); const x = <V loadError={a} />`)).toBe(false)
  })
})

import { analizar } from './comentarios'
import { fugasContaminadas } from './contaminacion'
import { exencionesReales } from './textoCrudo'
import { FORMAS_CONTAMINADAS, FORMAS_LIMPIAS } from './muestras/contaminadas'

/**
 * V5 — ¿Qué llega al atributo `loadError`? Si la expresión viene del error de la
 * base sin pasar por el traductor, el texto crudo de Postgres viaja al navegador
 * en el payload de Flight. No se enseña, pero llega, y R3 promete lo contrario.
 */
/**
 * W3 — La primera versión sólo reconocía el identificador pelado y marcaba como
 * "traducida" cualquier variable inicializada con una llamada: ocho de nueve
 * formas se colaban, y revertir el producto a `error ? error : null` —que
 * reintroduce la fuga del texto crudo al payload— dejaba el test verde. DoD 50 y
 * 58 estaban verdes por una razón que no era la que nombran.
 *
 * Ahora se contamina como en `unit/fugaDeError.ts`: lo que nace del error lo
 * sigue siendo aunque pase por un ternario, una plantilla o un `String()`; y sólo
 * lo limpia pasar por el traductor.
 */
/**
 * AC2 — Aquí había una lista de salidas de **dos**: el atributo `loadError` y el
 * spread. La revisión lo midió: `loadErrorCode={error}` pasaba, y
 * `<div>{error.message}</div>` —que se pinta en pantalla— no se miraba siquiera.
 * R3 promete que el crudo de Postgres no viaja al cliente, no que no viaja *por
 * `loadError`*.
 *
 * Ahora es la misma función que la guarda del arnés, con la misma semilla: la
 * contaminación tiene que morir en el traductor, salga por donde salga.
 */
export function fugasEnPagina(fuente: string, nombre = 'x.tsx'): string[] {
  const arbol = analizar(fuente, nombre)
  return fugasContaminadas(arbol, exencionesReales(arbol), { rechazosSonSemilla: true })
}

export const pasaCrudoAlCliente = (fuente: string, nombre = 'x.tsx'): boolean =>
  fugasEnPagina(fuente, nombre).length > 0

/**
 * Z3 / DoD 84 — El **mismo** banco que recorre la guarda del arnés. Compartían el
 * motor y no la cobertura, y la asimetría volvió una familia de formas más allá.
 */
describe('Z3 la guarda de la página caza el banco compartido', () => {
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\n"

  // AC3 — la misma exigencia que en la puerta hermana: el hallazgo cae en la
  // línea de la salida, no en la del `previo`, que dispara solo en seis formas.
  const conSalidaEnLinea = (previo: string, expr: string) => {
    const fuente = `${cabecera}${previo}\nconst x = <V loadError={${expr}} />`
    return { fugas: fugasEnPagina(fuente), linea: fuente.split('\n').length }
  }

  it.each(FORMAS_CONTAMINADAS as unknown as [string, string, string][])(
    'caza %s en la línea de la salida', (_n, previo, expr) => {
      const { fugas, linea } = conSalidaEnLinea(previo, expr)
      expect(fugas, 'esta forma se le cuela a la guarda de la página')
        .toContain(`jsx (línea ${linea})`)
    })

  // AD8 — 10 de las 42 filas tienen `previo` vacío: para ésas el control era la
  // misma cadena diez veces. Se afirma una vez, y el resto donde hay algo que
  // pueda ensuciar por su cuenta.
  it('sin forma y sin previo, la salida está limpia', () => {
    const { fugas, linea } = conSalidaEnLinea('', 'null')
    expect(fugas).not.toContain(`jsx (línea ${linea})`)
  })

  it.each(FORMAS_CONTAMINADAS.filter(([, p]) => p !== '') as unknown as [string, string, string][])(
    'y con null en su lugar, %s deja la salida limpia', (_n, previo) => {
      const { fugas, linea } = conSalidaEnLinea(previo, 'null')
      expect(fugas).not.toContain(`jsx (línea ${linea})`)
    })
})

/** AC9 / DoD 109 — la mitad negativa, por la otra puerta. */
describe('AC9 la guarda de la página no marca lo que está limpio', () => {
  const cabecera = "import { claseDe } from '@/lib/errors'\nconst error = { message: 'x', code: '1' }\n"
  it.each(FORMAS_LIMPIAS as unknown as [string, string, string][])(
    'deja pasar %s', (_n, previo, expr) => {
      expect(fugasEnPagina(`${cabecera}${previo}\nconst x = <V loadError={${expr}} />`),
        'la guarda marca lo limpio: entonces marcarlo todo la haría inútil').toEqual([])
    })
})

/**
 * AC2 / DoD 101 — La lista de salidas de esta guarda eran **dos**: el atributo
 * `loadError` y el spread. La revisión lo midió: `loadErrorCode={error}` pasaba, y
 * `<div>{error.message}</div>` —que se PINTA en pantalla, no ya en el payload—
 * no se miraba siquiera. R3 promete que el crudo de Postgres no viaja al cliente,
 * no que no viaja por `loadError`.
 */
describe('AC2 la salida no está enumerada', () => {
  const cabecera = "const error = { message: 'x', code: '1' }\n"
  it.each([
    ['otro atributo', 'const x = <V loadErrorCode={error} />'],
    ['un atributo cualquiera', 'const x = <V titulo={error.message} />'],
    ['texto pintado en pantalla', 'const x = <div>{error.message}</div>'],
    ['dentro de un hijo anidado', 'const x = <div><p><b>{String(error)}</b></p></div>'],
    ['una lista', 'const x = <ul>{[error].map(e => <li>{e}</li>)}</ul>'],
  ])('caza %s', (_n, forma) => {
    expect(fugasEnPagina(`${cabecera}${forma}`), 'la salida se coló').not.toEqual([])
  })
})
