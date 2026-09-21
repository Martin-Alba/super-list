import { describe, it, expect, afterAll } from 'vitest'
import { pool, newUser, newGroup, admin } from './helpers'
import { claseDe } from '../lib/errors'
import { createClient } from '@supabase/supabase-js'

afterAll(async () => { await pool.end() })

/**
 * T8 / DoD 40 — La tabla de códigos de R1 eran cadenas escritas a mano. Si
 * PostgREST renombra `PGRST301` o el trigger cambia su texto, todo cae a
 * `generico` y **no hay rojo**: el cimiento de R1 y S3 estaría anclado a la
 * memoria de quien escribió el test, no al entorno autoritativo.
 *
 * Aquí se provocan los errores de verdad y se afirma lo que la base devuelve.
 */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

describe('T8 los códigos salen de la base, no de la memoria', () => {
  it('los diez errores reales se clasifican como la tabla dice', async () => {
    const owner = await newUser('cod'); const gid = await newGroup(owner)
    const ajeno = await newUser('cod2')
    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', created_by: owner.id }).select('id').single()

    const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
    const caducado = createClient(URL_, ANON, { auth: { persistSession: false },
      global: { headers: { Authorization: 'Bearer no.es.un.jwt' } } })

    type Resultado = { error: { code?: string; message: string } | null }
    const casos: [string, () => PromiseLike<Resultado>, string][] = [
      ['sin sesión', () => anon.from('items').insert({ group_id: gid, name: 'x', created_by: owner.id }), 'sin-acceso'],
      ['token inválido', () => caducado.from('items').insert({ group_id: gid, name: 'x', created_by: owner.id }), 'sesion'],
      ['no miembro', () => ajeno.client.from('items').insert({ group_id: gid, name: 'x', created_by: ajeno.id }), 'sin-acceso'],
      ['nombre largo', () => owner.client.from('items').insert({ group_id: gid, name: 'z'.repeat(201), created_by: owner.id }), 'texto'],
      ['nombre en blanco', () => owner.client.from('items').insert({ group_id: gid, name: '   ', created_by: owner.id }), 'texto'],
      ['duplicado', () => owner.client.from('items').insert({ group_id: gid, name: 'PAN', created_by: owner.id }), 'duplicado'],
      ['resucitar borrado', async () => { await admin.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', fila!.id)
        return owner.client.from('items').update({ deleted_at: null }).eq('id', fila!.id) }, 'integridad'],
      ['cambiar el autor', () => owner.client.from('items').update({ created_by: ajeno.id }).eq('group_id', gid), 'integridad'],
      /**
       * Spec J / k5 — **El desvío del 23514, con el error que da la base.**
       *
       * `unit/errors.test.ts` lo prueba con una cadena que escribe el propio test, así que
       * si PostgREST dejara de poner el nombre de la restricción en `message` —o lo pusiera
       * sin comillas, o lo moviera a `details`— todo caería a `'texto'` **sin un solo rojo**.
       * Es literalmente la cicatriz que este fichero documenta, aplicada a la regla nueva.
       *
       * Y `items_quantity_len` está al lado a propósito: los dos son `23514` sobre la misma
       * columna, y sólo uno se desvía. Sin el segundo, ensanchar el patrón a
       * `/items_quantity/` pasaría por bueno.
       */
      ['cantidad fuera de rango', () => owner.client.from('items')
        .insert({ group_id: gid, name: 'cant', quantity: '100', created_by: owner.id }), 'cantidad'],
      /**
       * i3-R10 — Esta espera `'texto'` porque Postgres reporta el `check` que falla **por
       * nombre alfabético**, no por orden de creación, y `items_quantity_len` va antes que
       * `items_quantity_num`. Queda escrito: renombrar cualquiera de las dos invierte la clase
       * esperada, y sin esta nota ese rojo se lee como un fallo del producto.
       */
      ['cantidad demasiado larga', () => owner.client.from('items')
        .insert({ group_id: gid, name: 'cant2', quantity: 'q'.repeat(51), created_by: owner.id }), 'texto'],
    ]

    const observado: string[] = []
    for (const [etiqueta, ejecutar, esperado] of casos) {
      const { error } = await ejecutar()
      expect(error, `"${etiqueta}" ya no falla: el caso dejó de existir`).not.toBeNull()
      // AE8 — Esto llamaba a `clasificar`, que el producto ya no invoca: el
      // único test cuyas entradas vienen del entorno autoritativo atacaba una
      // función muerta. `claseDe` es la que `lib/items.ts` llama, y recibe el
      // OBJETO de error real, no dos campos elegidos a mano.
      const clase = claseDe(error, { haySesion: true })
      observado.push(`${etiqueta}: ${error!.code} → ${clase}`)
      expect(clase, `"${etiqueta}" da ${error!.code}/"${error!.message}"`).toBe(esperado)
    }
    expect(observado).toHaveLength(10)
  })
})
