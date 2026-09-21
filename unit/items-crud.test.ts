import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'
import { activeItems, softDeleteItem } from '../lib/items'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// R8 — con validación sólo de cliente, una llamada directa a la API mete el
// nombre vacío.
describe('R8 lista compartida', () => {
  it('la base rechaza un nombre vacío o de sólo espacios', async () => {
    const owner = await newUser('it'); const gid = await newGroup(owner)
    for (const name of ['', '   ', '\t\n']) {
      const { error } = await owner.client.from('items').insert({ group_id: gid, name, created_by: owner.id })
      expect(error, `aceptó el nombre ${JSON.stringify(name)}`).not.toBeNull()
    }
  })

  it('registra quién creó el ítem', async () => {
    const owner = await newUser('it2'); const gid = await newGroup(owner)
    // Spec J — la cantidad es `'2'`, no `'2 kg'`: este test afirma **quién creó el ítem**, y
    // el texto de la cantidad era sólo el ejemplo que tenía a mano. Desde J-R1 la base lo
    // rechaza, y cambiar el ejemplo no le quita nada a lo que la fila prueba.
    await owner.client.from('items').insert({ group_id: gid, name: 'pan', quantity: '2', created_by: owner.id })
    const rows = await sql('select name, quantity, created_by from public.items where group_id=$1', [gid])
    expect(rows).toEqual([{ name: 'pan', quantity: '2', created_by: owner.id }])
  })

  it('borrar es lógico: la fila sigue existiendo y sale de las lecturas', async () => {
    const owner = await newUser('it3'); const gid = await newGroup(owner)
    const { data: ins } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'huevos', created_by: owner.id }).select('id').single()
    await softDeleteItem(owner.client, ins!.id)

    const rows = await sql('select deleted_at from public.items where id=$1', [ins!.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).not.toBeNull()

    const visible = await activeItems(owner.client, gid)
    expect(visible.clase, 'la lectura falló y el test lo dio por bueno').toBeNull()
    expect(visible.data.map(i => i.id)).not.toContain(ins!.id)
  })
})

/**
 * Spec J / J-R1, j1, j2 — **El invariante lo hace cumplir la base** (§D.2), y se comprueba en
 * la capa que el requisito nombra: con el token del usuario, sin pasar por la interfaz. Un test
 * de vista sobre esto pasaría mientras una llamada directa a la API sigue metiendo «2 briks».
 */
describe('Spec J · la cantidad es un entero de 1 a 99, o nada', () => {
  it('j1: la base rechaza lo que no lo es', async () => {
    const owner = await newUser('j-no'); const gid = await newGroup(owner)
    // `0` y `100` están aquí a propósito: el campo los deja teclear —es el borde escrito de la
    // spec— y quien los para es esto. Si algún día el campo los recorta, este test no cambia.
    for (const quantity of ['0', '100', '2 briks', '-3', '007', ' 5', '5 ', '00', '1.5', '1,5', '299']) {
      const { error } = await owner.client.from('items')
        .insert({ group_id: gid, name: `p-${quantity}`, quantity, created_by: owner.id })
      expect(error, `la base aceptó la cantidad ${JSON.stringify(quantity)}`).not.toBeNull()
    }
  })

  /**
   * j2 — `[REGRESIÓN]`, y declarado: estaba verde antes del cambio, porque antes la columna
   * aceptaba cualquier texto. No prueba el trabajo; es la mitad que la restricción podía
   * romper de más, y la que se pone roja si el regex se aprieta por accidente.
   *
   * Y es la sonda de j1: sin un caso que entre, «rechaza lo que no vale» no se distingue de
   * «rechaza todo», y una columna que no acepta ninguna cantidad cumpliría j1 entero.
   */
  it('j2: …y acepta 1, 99 y la cantidad vacía', async () => {
    const owner = await newUser('j-si'); const gid = await newGroup(owner)
    for (const quantity of ['1', '99', '7', '42', null]) {
      const { error } = await owner.client.from('items')
        .insert({ group_id: gid, name: `p-${quantity}`, quantity, created_by: owner.id })
      expect(error, `la base rechazó la cantidad válida ${JSON.stringify(quantity)}`).toBeNull()
    }
  })
})

/**
 * AE1 / DoD 127 — `activeItems` hacía `throw error`, y ése era el objeto crudo de
 * la base saliendo del módulo: en `GroupView.tsx` lo recogía un `.catch`, y
 * `String(e)` pintaba `PostgrestError: permission denied for table items`.
 *
 * Ahora no lanza nunca. Se comprueba con las dos formas de fallar que tiene: la
 * que la base contesta (RLS deniega) y la que no llega a contestar (transporte
 * roto), porque la segunda llegaba como promesa rechazada.
 */
describe('AE1 activeItems no deja salir el error de la base', () => {
  it('con la base contestando un error, devuelve su clase en vez de lanzar', async () => {
    const dueno = await newUser('ae-owner')
    // Un uuid mal formado: PostgREST contesta `22P02`, que es un error de la
    // base **respondido**, no una promesa rechazada. Es el caso que el `throw`
    // sacaba del módulo; leer una lista ajena no vale, porque RLS filtra en vez
    // de dar error y el test pasaría con el `throw` puesto.
    const r = await activeItems(dueno.client, 'no-soy-un-uuid')
    expect(r.clase, 'la base contestó un error y no llegó como clase').toBeTruthy()
    expect(r.code, 'el código de Postgres se perdió').toBeTruthy()
    expect(r.data).toEqual([])
    expect(r).not.toHaveProperty('error')
  })

  it('con el transporte roto, tampoco lanza', async () => {
    const roto = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false },
        global: { fetch: () => Promise.reject(new Error('network aborted')) } },
    )
    const r = await activeItems(roto, '00000000-0000-4000-8000-000000000000')
    expect(r.clase, 'el fallo se perdió y quedó como lista vacía').toBeTruthy()
    expect(r.data).toEqual([])
  })
})
