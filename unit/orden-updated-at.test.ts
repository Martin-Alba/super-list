import { describe, it, expect, afterAll } from 'vitest'
import { sql, pool, newUser, newGroup } from './helpers'

afterAll(async () => { await pool.end() })

/**
 * X1 / DoD 68, 69 — `updated_at` es la clave con la que la vista decide quién
 * gana al fusionar la respuesta de una escritura con lo que llega por el canal
 * (J6, W1). Si no ordena, W1 elige la fila vieja y revierte en pantalla el cambio
 * correcto de otro miembro.
 *
 * `now()` es la hora de **inicio de transacción**: dos escrituras concurrentes
 * podían recibir el mismo valor o quedar invertidas. Medido antes del cambio: 3 de 300
 * pares a resolución de milisegundo, y de 41 a 86 midiendo en microsegundos, que
 * es la precisión real de la columna. `clock_timestamp()` es la hora de aplicación.
 */
/** Sin zona horaria ni ceros de relleno: comparable como cadena, sin perder µs. */
const normalizar = (t: string) => new Date(t).toISOString().slice(0, 19) +
  '.' + (t.match(/\.(\d+)/)?.[1] ?? '0').padEnd(6, '0')

describe('X1 la clave de orden ordena', () => {
  it('el trigger usa la hora de aplicación, no la del BEGIN', async () => {
    const [fila] = await sql<{ src: string }>(
      `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'touch_updated_at'`)
    expect(fila.src, 'volvió a `now()`, que congela la hora en el BEGIN')
      .toContain('clock_timestamp()')
    expect(fila.src).not.toMatch(/:=\s*now\(\)/)
  })

  it('300 pares concurrentes no dejan ninguna inversión', async () => {
    const owner = await newUser('ord'); const gid = await newGroup(owner)
    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', created_by: owner.id }).select('id').single()

    let inversiones = 0
    for (let i = 0; i < 300; i++) {
      const [a, b] = await Promise.all([
        owner.client.from('items').update({ name: `a${i}` }).eq('id', fila!.id).select('updated_at').single(),
        owner.client.from('items').update({ quantity: `${i}` }).eq('id', fila!.id).select('updated_at').single(),
      ])
      const devueltos = [a.data?.updated_at, b.data?.updated_at].filter(Boolean) as string[]
      if (devueltos.length < 2) continue
      const [{ guardado }] = await sql<{ guardado: string }>(
        'select updated_at::text as guardado from public.items where id = $1', [fila!.id])
      // La versión que la base conserva no puede ser MÁS VIEJA que la que se le
      // devolvió a cualquiera de los dos escritores: si lo es, la vista elegirá
      // la fila vieja y revertirá el cambio ajeno.
      /**
       * Y4 — Esto comparaba con `new Date()`, que trunca microsegundos a
       * milisegundos: el rojo salía 2 de 6 veces y la cifra publicada quedaba
       * infravalorada unas veinte veces. Se comparan los textos normalizados.
       */
      const masNuevoDevuelto = devueltos.map(normalizar).sort().at(-1)!
      if (normalizar(guardado) < masNuevoDevuelto) inversiones++
    }
    expect(inversiones, 'la clave de orden no ordena: W1 revertirá cambios ajenos correctos')
      .toBe(0)
  }, 120_000)
})

/**
 * Y1 / DoD 74, 75 — X1 arregló quién escribe la hora y dejó abierto **quién puede
 * escribir la columna**. Un miembro activo insertaba `updated_at: 2999` y la fila
 * quedaba envenenada: a partir de ahí la fusión elige siempre la versión vieja y
 * la primera edición de cualquiera se revierte en pantalla. Es B.5 literal.
 */
describe('Y1 la hora es autoridad del servidor', () => {
  it('un miembro no puede escribir updated_at ni created_at', async () => {
    const owner = await newUser('aut'); const gid = await newGroup(owner)
    const { error } = await owner.client.from('items').insert({
      group_id: gid, name: 'veneno', created_by: owner.id,
      updated_at: '2999-01-01T00:00:00Z',
    })
    expect(error, 'el cliente pudo mandar la hora: la clave de orden es suya').not.toBeNull()

    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'normal', created_by: owner.id }).select('id').single()
    const { error: eUpd } = await owner.client.from('items')
      .update({ updated_at: '2999-01-01T00:00:00Z' }).eq('id', fila!.id)
    expect(eUpd, 'el cliente pudo reescribir la hora al editar').not.toBeNull()
  })

  it('una fila recién insertada trae la hora del servidor', async () => {
    const owner = await newUser('aut2'); const gid = await newGroup(owner)
    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', created_by: owner.id })
      .select('updated_at').single()
    const cuando = new Date(fila!.updated_at).getTime()
    expect(Math.abs(Date.now() - cuando), 'la hora del INSERT no la pone el servidor')
      .toBeLessThan(60_000)
  })

  // DoD 76 — el mecanismo entero puede desaparecer de la base sin un solo rojo.
  it('el trigger está enganchado a INSERT y a UPDATE', async () => {
    const [t] = await sql<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.items'::regclass and tgname = 'items_touch_updated_at'`)
    expect(t?.def, 'el trigger no está: `updated_at` se congela y la fusión deja de ceder')
      .toBeTruthy()
    expect(t.def).toMatch(/BEFORE INSERT OR UPDATE/i)
  })

  it('y `updated_at` avanza de verdad tras una escritura', async () => {
    const owner = await newUser('aut3'); const gid = await newGroup(owner)
    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', created_by: owner.id })
      .select('id, updated_at').single()
    const { data: tras } = await owner.client.from('items')
      .update({ name: 'pan integral' }).eq('id', fila!.id).select('updated_at').single()
    expect(normalizar(tras!.updated_at) > normalizar(fila!.updated_at),
      'la hora no avanzó: el trigger está pero no dispara').toBe(true)
  })
})
