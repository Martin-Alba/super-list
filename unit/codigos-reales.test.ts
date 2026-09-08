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
  it('los ocho errores reales se clasifican como la tabla dice', async () => {
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
    ]

    const observado: string[] = []
    for (const [etiqueta, ejecutar, esperado] of casos) {
      const { error } = await ejecutar()
      expect(error, `"${etiqueta}" ya no falla: el caso dejó de existir`).not.toBeNull()
      // AE8 — Esto llamaba a `clasificar`, que el producto ya no invoca: el
      // único test cuyas entradas vienen del entorno autoritativo atacaba una
      // función muerta. `claseDe` es la que `lib/items.ts` llama, y recibe el
      // OBJETO de error real, no dos campos elegidos a mano.
      const clase = claseDe(error, true)
      observado.push(`${etiqueta}: ${error!.code} → ${clase}`)
      expect(clase, `"${etiqueta}" da ${error!.code}/"${error!.message}"`).toBe(esperado)
    }
    expect(observado).toHaveLength(8)
  })
})
