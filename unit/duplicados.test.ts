import { describe, it, expect, afterAll } from 'vitest'
import { borradosEnSql } from './borradoFisico'
import {
  SQL_QUE_BORRA, SQL_CON_CTE, SQL_CON_CTE_ANIDADA, SQL_CON_DOS_CTE, SQL_DINAMICO,
  SQL_CTE_CON_COLUMNAS, SQL_BUCLE_PLPGSQL, SQL_IF_PLPGSQL, SQL_EXECUTE_VARIABLE, SQL_MAS_FORMAS,
} from './muestras/borrados'
import { readFileSync } from 'node:fs'
import { sql, pool, newUser, newGroup } from './helpers'

/**
 * R7 / DoD 10, 11, 16 — La invariante la impone el ALMACÉN. Comprobar en el
 * cliente antes de insertar es el `check-then-act` que la constitución veta, y no
 * resuelve la carrera real: dos altas simultáneas no se ven entre ellas. Medido
 * en el QA antes del cambio, quedaban dos filas.
 */
afterAll(async () => { await pool.end() })

describe('R7 el índice único decide', () => {
  it('el índice existe, es parcial y normaliza', async () => {
    const [fila] = await sql<{ def: string }>(
      `select indexdef as def from pg_indexes where indexname = 'items_nombre_unico'`)
    expect(fila?.def, 'sin índice, la carrera la gana quien llegue segundo').toBeTruthy()
    expect(fila.def).toContain('UNIQUE')
    expect(fila.def, 'un índice total impediría volver a añadir algo borrado')
      .toContain('deleted_at IS NULL')
    expect(fila.def).toMatch(/lower|translate/i)
  })

  it('rechaza el duplicado con 23505, y sólo por diferencias que NO cuentan', async () => {
    const owner = await newUser('dup'); const gid = await newGroup(owner)
    await owner.client.from('items').insert({ group_id: gid, name: 'Cebolla', created_by: owner.id })

    for (const variante of ['cebolla', 'CEBOLLA', '  Cebolla  ']) {
      const { error } = await owner.client.from('items')
        .insert({ group_id: gid, name: variante, created_by: owner.id })
      expect(error?.code, `"${variante}" entró como producto distinto`).toBe('23505')
    }
    // La ñ es letra propia: `piña` y `pina` NO son el mismo producto.
    await owner.client.from('items').insert({ group_id: gid, name: 'Piña', created_by: owner.id })
    const { error: eNe } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pina', created_by: owner.id })
    expect(eNe, 'la ñ se fundió con la n: "año" y "ano" serían el mismo producto').toBeNull()
  })

  // DoD 16 — el índice es PARCIAL: lo borrado no bloquea.
  it('un nombre igual al de un ítem borrado se puede volver a añadir', async () => {
    const owner = await newUser('dup2'); const gid = await newGroup(owner)
    const { data } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'Plátano', created_by: owner.id }).select('id').single()
    await owner.client.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', data!.id)
    const { error } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'platano', created_by: owner.id })
    expect(error, 'un índice total dejaría el nombre bloqueado para siempre').toBeNull()
  })

  it('el mismo nombre en OTRO grupo no choca', async () => {
    const owner = await newUser('dup3')
    const g1 = await newGroup(owner), g2 = await newGroup(owner, 'Otro')
    await owner.client.from('items').insert({ group_id: g1, name: 'sal', created_by: owner.id })
    const { error } = await owner.client.from('items')
      .insert({ group_id: g2, name: 'sal', created_by: owner.id })
    expect(error, 'el índice no está acotado por grupo').toBeNull()
  })
})

describe('R7 la migración es idempotente y no borra en duro', () => {
  const FUENTE = readFileSync('supabase/migrations/20260908000100_duplicados.sql', 'utf8')

  it('resuelve los duplicados con borrado SUAVE', () => {
    // U8 — esto era `not.toMatch(/delete\s+from/i)`: la búsqueda de texto que
    // este repositorio ya se pagó cuatro veces. El analizador de SQL existe.
    expect(borradosEnSql(FUENTE), 'un DELETE físico sobre items es un hard fail de B.3').toEqual([])
    expect(FUENTE).toMatch(/set deleted_at = now\(\)/)
  })

  it.each([
    ['directa', SQL_QUE_BORRA],
    // V6 — las dos formas que se colaban, y son las naturales: una CTE es como
    // se escribe una deduplicación, y `execute` es LA forma de borrar en plpgsql.
    ['tras una CTE', SQL_CON_CTE],
    // W2 / DoD 63 — la forma canónica de una deduplicación: `row_number() over (…)`
    // mete paréntesis anidados, y el despojado se paraba en el primero.
    ['tras una CTE con paréntesis anidados', SQL_CON_CTE_ANIDADA],
    ['tras dos CTE encadenadas', SQL_CON_DOS_CTE],
    ['por SQL dinámico', SQL_DINAMICO],
    // X3 / DoD 71 — las cuatro que se colaban.
    ['tras una CTE con lista de columnas', SQL_CTE_CON_COLUMNAS],
    ['dentro de un bucle plpgsql', SQL_BUCLE_PLPGSQL],
    ['dentro de un if plpgsql', SQL_IF_PLPGSQL],
    ['por execute con la sentencia en variable', SQL_EXECUTE_VARIABLE],
    // Y7 / DoD 81 — las ocho formas nuevas que la revisión midió coladas.
    ...SQL_MAS_FORMAS,
  ])('y la guarda caza una migración que borra %s', (_n, muestra) => {
    expect(borradosEnSql(muestra)).not.toEqual([])
  })

  it('crear el índice es repetible', () => {
    expect(FUENTE).toMatch(/create unique index if not exists/i)
  })

  it('no quedan duplicados activos en la base', async () => {
    const filas = await sql<{ n: string }>(`
      select count(*)::text as n from (
        select group_id, translate(lower(btrim(name)),
          'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
          'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
        from public.items where deleted_at is null group by 1,2 having count(*) > 1) x`)
    expect(filas[0].n).toBe('0')
  })
})
