import { describe, it, expect, afterAll } from 'vitest'
import { borradosEnSql } from './borradoFisico'
import {
  SQL_QUE_BORRA, SQL_CON_CTE, SQL_CON_CTE_ANIDADA, SQL_CON_DOS_CTE, SQL_DINAMICO,
  SQL_CTE_CON_COLUMNAS, SQL_BUCLE_PLPGSQL, SQL_IF_PLPGSQL, SQL_EXECUTE_VARIABLE, SQL_MAS_FORMAS,
  REF_QUE_NO_ES_COLECCION, REF_SIN_DECLARAR, REF_CON_MAP,
} from './muestras/borrados'
import { borradosFisicos } from './borradoFisico'
import { readFileSync } from 'node:fs'
import { sql, pool, newUser, newGroup } from './helpers'
import { addItem } from '@/lib/items'

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

  /**
   * Spec F / F2 — **La fila que prueba el requisito.** El índice de nombre es PARCIAL, así que
   * en cuanto alguien tacha el producto un reenvío ya no choca: inserta, y lo que el usuario
   * quitó vuelve. Es la resurrección de la deuda 64, atacada en la capa que el requisito nombra
   * —la base, con el token del usuario— y a través del camino de envío del producto.
   */
  it('F2: el reenvío de la misma fila no resucita un producto tachado', async () => {
    const owner = await newUser('f2'); const gid = await newGroup(owner)
    const fila = { id: crypto.randomUUID(), nombre: 'Pan', cantidad: null }
    const r1 = await addItem(owner.client, gid, owner.id, fila)
    expect(r1.clase, 'el primer envío tiene que entrar: sin camino feliz no se distingue una guarda de una avería').toBeNull()
    await owner.client.from('items')
      .update({ deleted_at: new Date().toISOString() }).eq('id', r1.data!.id)

    const r2 = await addItem(owner.client, gid, owner.id, fila)
    expect(r2.code, 'el reenvío insertó en vez de chocar').toBe('23505')
    const vivos = await sql(`select 1 from items where group_id = $1 and deleted_at is null`, [gid])
    expect(vivos, 'resurrección: la fila que alguien tachó volvió a la lista').toHaveLength(0)
  })

  /**
   * Spec F / F1 — Y **qué** índice hace el trabajo, no sólo que algo lo haga. Dos nombres
   * distintos con la misma clave de origen: el índice de nombre no puede cazar esto —los
   * nombres difieren—, así que sólo `items_origen_unico` puede. Sin esta fila, F1 estaría verde
   * por el mecanismo equivocado.
   */
  it('F1: el mecanismo es la clave de origen, no el índice de nombre', async () => {
    const owner = await newUser('f1'); const gid = await newGroup(owner)
    const origen = crypto.randomUUID()
    expect((await addItem(owner.client, gid, owner.id,
      { id: origen, nombre: 'Sal', cantidad: null })).clase).toBeNull()
    const r2 = await addItem(owner.client, gid, owner.id,
      { id: origen, nombre: 'Azúcar', cantidad: null })
    expect(r2.code, 'nombres distintos y misma clave: si esto entra, la clave de origen no viajó')
      .toBe('23505')
  })

  /**
   * Spec F / iteración 1 · i1-7 — **El orden de despliegue deja de depender de que alguien se
   * acuerde.** Medido por la revisión: con el código delante de la migración, PostgREST devuelve
   * `PGRST204`, el cliente lo clasifica como `generico`, el usuario lee «No se ha podido completar
   * la operación.», el drenado **para en la primera fila** porque el código no es 23505, y a las
   * 24 h `reparte` descarta la compra. Falla cerrado, pero no se puede añadir nada.
   *
   * Esta fila es la mitad que una prueba puede cubrir: la verja lee el catálogo del entorno y se
   * pone roja si la columna que el envío necesita no está. La otra mitad —un paso de CI o de
   * despliegue que ordene los dos— necesita mano humana y está declarada fuera en la spec.
   */
  it('i1-7: la columna que el envío necesita existe en la base, con su privilegio', async () => {
    const cols = await sql<{ n: string }>(
      `select column_name as n from information_schema.columns
        where table_schema='public' and table_name='items' and column_name='origen_id'`)
    expect(cols, 'sin la columna, cada alta da un error genérico y la cola no drena nunca').toHaveLength(1)
    const priv = await sql<{ p: string }>(
      `select privilege_type as p from information_schema.column_privileges
        where table_name='items' and grantee='authenticated' and column_name='origen_id'
        order by 1`)
    expect(priv.map(x => x.p), 'el cliente necesita escribirla y leerla, y no reescribirla')
      .toEqual(['INSERT', 'SELECT'])
  })

  /**
   * Spec F / iteración 1 · i1-5 — **El índice, leído del catálogo, con los dos ejes separados.**
   *
   * La revisión midió que la idempotencia de la migración es por **nombre** y no por definición:
   * un `items_origen_unico` preexistente que fuera parcial sobre `deleted_at` sobreviviría al
   * `create ... if not exists`, la migración diría OK y la garantía central de F estaría ausente
   * en silencio. Esta fila lo caza nombrando la causa, en vez de esperar a que F2 caiga por el
   * síntoma.
   */
  it('i1-5: el índice de origen es parcial sobre la clave, y NUNCA sobre lo tachado', async () => {
    const [fila] = await sql<{ def: string }>(
      `select indexdef as def from pg_indexes where indexname = 'items_origen_unico'`)
    expect(fila?.def, 'sin índice de origen, el reenvío sobre lo tachado vuelve a insertar').toBeTruthy()
    expect(fila.def).toContain('UNIQUE')
    expect(fila.def, 'la clave tiene que ser por grupo').toMatch(/group_id, origen_id/)
    expect(fila.def, 'parcial sobre `origen_id is not null`: las filas sin clave no deduplican')
      .toMatch(/WHERE \(origen_id IS NOT NULL\)/i)
    expect(fila.def, 'parcial sobre `deleted_at` sería la regresión: el reenvío sobre lo tachado dejaría de chocar')
      .not.toMatch(/deleted_at/i)
  })

  /**
   * Spec F / F1bis — Y la otra mitad del mecanismo: la clave es **por grupo**, así que la misma
   * fila en otro grupo sí entra. Es lo que hace que el borde de «un uuid que ya existe en otro
   * grupo» no exista, en vez de aceptarse por nombre.
   */
  it('F1bis: la misma clave de origen en otro grupo sí entra', async () => {
    const owner = await newUser('f1b')
    const g1 = await newGroup(owner), g2 = await newGroup(owner, 'Otro')
    const fila = { id: crypto.randomUUID(), nombre: 'Sal', cantidad: null }
    expect((await addItem(owner.client, g1, owner.id, fila)).clase).toBeNull()
    expect((await addItem(owner.client, g2, owner.id, fila)).clase,
      'la clave se acotó de más: dos grupos no comparten cola').toBeNull()
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

/**
 * Spec F / iteración 2 — **La sonda del salto por `ref.current`.** La guarda de borrado físico
 * aprendió a atravesar un `useRef(new Map())`, porque una colección es igual de inofensiva dentro
 * de un ref que fuera. Un salto que no se pueda cerrar sería una puerta, así que se comprueba en
 * las dos direcciones.
 */
describe('Spec F / i2 · el salto por `ref.current` no es una puerta', () => {
  it('un ref que envuelve un Map queda exento', () => {
    expect(borradosFisicos(REF_CON_MAP, 'app/x.tsx', { activa: false }),
      'un `Map` dentro de un ref se marca: la guarda acusa a lo inofensivo').toEqual([])
  })
  it('un ref que NO envuelve una colección sigue marcado', () => {
    expect(borradosFisicos(REF_QUE_NO_ES_COLECCION, 'app/x.tsx', { activa: false }).length,
      'el salto exime cualquier `ref.current`: sería una puerta').toBeGreaterThan(0)
  })
  it('y un ref que no se declara en el fichero también', () => {
    expect(borradosFisicos(REF_SIN_DECLARAR, 'app/x.tsx', { activa: false }).length,
      'sin declaración no se puede demostrar nada, y se dio por bueno').toBeGreaterThan(0)
  })
})
