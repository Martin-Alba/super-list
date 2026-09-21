import { describe, it, expect, afterAll } from 'vitest'
import { newUser, newGroup, sql, pool, dejarCoherente, coherente, limpiarAlTerminar, miembroActivo, ownersActivos, type Hallazgo } from './helpers'

/**
 * Spec H / iteración 1 — **Las dos carreras, atacadas con dos conexiones de verdad.**
 *
 * Dos llamadas `await` seguidas contra PostgREST no representan esto: cada una abre y cierra su
 * transacción, así que nunca se solapan. Lo que estos casos necesitan es una transacción **abierta y
 * sin confirmar** mientras la otra corre, y eso exige hablar con Postgres directamente.
 *
 * La identidad se siembra como la siembra PostgREST: `request.jwt.claims` con el `sub`, que es de
 * donde `auth.uid()` la saca (leído del catálogo, no supuesto).
 */
const comoUsuario = async (uid: string) => {
  const c = await pool.connect()
  await c.query('begin')
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid })])
  return c
}

/**
 * **Esperar a ver la otra sesión bloqueada, no a que pase el tiempo.** La primera versión hacía
 * `commit` justo después de lanzar la consulta de S2, y medido: el commit ganaba la carrera, la
 * puerta de `decide_member` veía el mundo ya transferido y devolvía «only the owner can decide» —
 * el test fallaba por su propio montaje, no por el producto. El bloqueo es observable en el
 * catálogo, así que se observa en vez de suponerse.
 */
const esperarBloqueo = async (pid: number) => {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: string }>(
      "select count(*) as n from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])
    if (Number(r[0].n) > 0) return
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error('la otra sesión nunca se bloqueó: el escenario de carrera no se montó')
}

const pidDe = async (c: { query: (q: string) => Promise<{ rows: Array<{ pid: number }> }> }) =>
  (await c.query('select pg_backend_pid() as pid')).rows[0].pid

/**
 * i2-R4 — **Repara e informa, porque reparar y callar borra la prueba.**
 *
 * Esta función arregla exactamente los tres estados que vigilan los tres barridos globales, sin
 * condiciones y en `finally`. Eso la hacía incapaz de distinguir «el test pasó» de «el producto se
 * rompió y yo borré la evidencia»: un `delete_group` que marcara `deleted_at` y fallara al expulsar
 * al owner quedaba reescrito como grupo sano y vivo, y las aserciones de i1-3 —`invalid` y la fila
 * ausente— seguían pasando tan contentas.
 *
 * La reparación se queda: es la condición para que la base siga siendo medible entre corridas. Lo
 * que se añade es que **devuelve lo que encontró**, y quien la llama afirma la coherencia **fuera**
 * del `finally`, donde un fallo sí se ve.
 */
afterAll(async () => { await pool.end() })

describe('Spec H / i1-R1 · un grupo vivo no puede quedarse sin dueño', () => {
  it('i1-1: transferir y expulsar cruzados dejan el grupo con UN owner activo', async () => {
    const owner = await newUser('c1o'); const gid = await newGroup(owner)
    const b = await newUser('c1b'); await miembroActivo(gid, b.id)

    const s1 = await comoUsuario(owner.id)
    const s2 = await comoUsuario(owner.id)
    let hallazgo: Hallazgo | undefined
    try {
      // S1 transfiere a B y NO confirma.
      await s1.query('select public.transfer_group($1,$2)', [gid, b.id])

      // S2 intenta expulsar a B. Su `is_group_owner` ve al viejo owner todavía activo, así que pasa
      // la puerta; el `update` se bloquea en la fila de B, que S1 tiene tomada.
      const pid2 = await pidDe(s2)
      const expulsion = s2.query('select public.decide_member($1,$2,$3)', [gid, b.id, 'removed'])
      await esperarBloqueo(pid2)

      await s1.query('commit')
      await expulsion   // se desbloquea y re-evalúa el `where` contra la fila nueva
      await s2.query('commit')

      expect(await ownersActivos(gid),
        'el grupo quedó vivo y sin dueño: nadie puede repararlo desde la app').toBe(1)
      const filaB = await sql<{ role: string; status: string }>(
        'select role, status from public.group_members where group_id=$1 and user_id=$2', [gid, b.id])
      expect(filaB, 'el nuevo owner fue expulsado por la carrera').toEqual([{ role: 'owner', status: 'active' }])

      const vivo = await sql<{ deleted_at: string | null }>('select deleted_at from public.groups where id=$1', [gid])
      expect(vivo[0].deleted_at, 'el grupo debería seguir vivo').toBeNull()
    } finally {
      await s1.query('rollback').catch(() => {}); s1.release()
      await s2.query('rollback').catch(() => {}); s2.release()
      hallazgo = await dejarCoherente(gid)
    }
    coherente(hallazgo!)
  })

  /**
   * **`i1-2` se borró en la iteración 2, y su hueco no se rellena.** Decía atacar el `and m.role <>
   * 'owner'` del `update` de `decide_member`, y medido por la revisión **nunca llegaba al `update`**:
   * llamaba como B sobre sí mismo, así que la cazaba la puerta preexistente «el owner no puede
   * actuar sobre su propia membresía», y su aserción final la cumplía el propio montaje porque el
   * índice parcial rechazaba la tercera escritura. Ningún cambio en `decide_member` la ponía roja, y
   * ocupaba el sitio reservado al CRITICAL de esa vuelta.
   *
   * La revisión proponía reconstruirla sembrando `role='owner'` con `status='pending'`. La
   * iteración 2 hace esa forma **irrepresentable** con un `check` en la base, así que el caso deja de
   * existir: fuera de la carrera que `i1-1` cubre, no queda camino alcanzable. Lo que se vigila ahora
   * es que la base rechaza la forma —`unit/grupo-vida.test.ts` › «i2-2»—, que es donde vive la
   * guarda desde que se mudó.
   */
})

describe('Spec H / i1-R2 · borrar y solicitar no pueden cruzarse', () => {
  it('i1-3: con el borrado en vuelo, una solicitud no entra en el grupo muerto', async () => {
    const owner = await newUser('c3o'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const invitado = await newUser('c3i')

    const s1 = await comoUsuario(owner.id)
    const s2 = await comoUsuario(invitado.id)
    let hallazgo: Hallazgo | undefined
    try {
      await s1.query('select public.delete_group($1)', [gid])       // sin confirmar
      const pid2 = await pidDe(s2)
      const solicitud = s2.query('select public.request_join($1) as r', [token])
      await esperarBloqueo(pid2)
      await s1.query('commit')
      const res = await solicitud
      await s2.query('commit')
      expect(res.rows[0].r.status,
        'entró una solicitud en un grupo borrado: callejón sin owner que la apruebe').toBe('invalid')
    } finally {
      await s1.query('rollback').catch(() => {}); s1.release()
      await s2.query('rollback').catch(() => {}); s2.release()
      hallazgo = await dejarCoherente(gid)
    }
    // Aquí el borrado **sí** es lo esperado: un `delete_group` que marcara la fila y no expulsara al
    // owner pasaría las dos aserciones de abajo, y es justo lo que la reparación ciega tapaba.
    coherente(hallazgo!, true)

    const filas = await sql<{ status: string }>(
      'select status from public.group_members where group_id=$1 and user_id=$2', [gid, invitado.id])
    expect(filas, 'quedó una fila del solicitante en un grupo borrado').toEqual([])
  })
})

describe('Spec H / i3-R3 · la reparación comprueba que reparó', () => {
  it('i4-2: un fallo de la REPARACIÓN levanta con el mensaje de su guarda', async () => {
    /**
     * **La declaración de no-cobertura de `i3-5` era falsa, y es el sexto registro falso de esta
     * spec.** Escribí que no era construible porque enumeré las *restricciones* que los `update` de
     * reparación pueden violar y concluí que ninguna era alcanzable. Me dejé los **temporizadores**:
     * el rol `authenticator` —por el que entra PostgREST— lleva `statement_timeout` y `lock_timeout`
     * de 8 s en su `rolconfig`. Sosteniendo la fila de `groups` desde otra conexión, el `update` de
     * la reparación muere y la guarda levanta con su propio mensaje.
     *
     * Enumerar una familia de causas y concluir «no es construible» es exactamente el error que la
     * spec advierte en su propia sección 2: una respuesta construida vale, una ausencia de respuesta
     * mide al autor.
     */
    const owner = await newUser('c6o'); const gid = await newGroup(owner)
    const tenedor = await comoUsuario(owner.id)
    try {
      await tenedor.query('select 1 from public.groups where id = $1 for update', [gid])
      await expect(dejarCoherente(gid),
        'la reparación murió y la limpieza devolvió como si todo estuviera bien')
        .rejects.toThrow(/la reparación de .* falló/)
    } finally {
      await tenedor.query('rollback').catch(() => {}); tenedor.release()
    }
  }, 30_000)

})

describe('Spec H / i2-R7 · y el orden inverso, que el `for update` también abre', () => {
  /**
   * §E.4(b) — El arreglo cambió el mecanismo: ahora las dos funciones se serializan sobre la fila de
   * owner. Eso **abre un camino que antes no existía** —solicitar primero y borrar después, con el
   * borrado esperando al cerrojo—, y i1-3 sólo recorre el otro. Medido: es seguro, porque la
   * solicitud entra como `pending` y el `update` masivo del borrado la barre. Cuesta poco y no lo
   * vigilaba nadie.
   */
  it('i2-7: solicitar primero y borrar después deja al solicitante fuera', async () => {
    const owner = await newUser('c5o'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const invitado = await newUser('c5i')

    const s1 = await comoUsuario(invitado.id)
    const s2 = await comoUsuario(owner.id)
    let hallazgo: Hallazgo | undefined
    try {
      const r = await s1.query('select public.request_join($1) as r', [token])
      expect(r.rows[0].r.status, 'la solicitud no entró: el escenario no se monta').toBe('pending')

      const pid2 = await pidDe(s2)
      const borrado = s2.query('select public.delete_group($1)', [gid])
      await esperarBloqueo(pid2)
      await s1.query('commit')
      await borrado
      await s2.query('commit')
    } finally {
      await s1.query('rollback').catch(() => {}); s1.release()
      await s2.query('rollback').catch(() => {}); s2.release()
      hallazgo = await dejarCoherente(gid)
    }
    coherente(hallazgo!, true)

    const filas = await sql<{ status: string }>(
      'select status from public.group_members where group_id=$1 and user_id=$2', [gid, invitado.id])
    expect(filas, 'el solicitante quedó dentro de un grupo borrado').toEqual([{ status: 'removed' }])
  })
})

describe('Spec H / i1-R7 · el reintento de una transferencia que ya entró', () => {
  it('i1-8: repetir transfer_group no grita sobre algo que funcionó', async () => {
    const owner = await newUser('c4o'); const gid = await newGroup(owner)
    const b = await newUser('c4b'); await miembroActivo(gid, b.id)

    const primera = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    expect(primera.error, 'la transferencia falló').toBeNull()
    /**
     * El cliente acota cada RPC a 10 s (`RPC_TIMEOUT_MS`). Un aborto **después** del commit deja al
     * cliente creyendo que falló, y su reintento llegaría aquí. Un 42501 diría «sólo el owner puede
     * transferir» sobre algo que sí funcionó — la misma lección que la iteración base aplicó a
     * `delete_group` y no a su gemela.
     */
    const segunda = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    expect(segunda.error, 'el reintento gritó sobre una transferencia que ya había entrado').toBeNull()
    limpiarAlTerminar(gid)
  })
})
