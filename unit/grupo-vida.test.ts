import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql, admin, limpiarAlTerminar, ownersActivos, rolDe } from './helpers'

/**
 * Spec H — Transferir y borrar grupo, atacado en la capa que los requisitos nombran (§E.1): la
 * base, con el token de cada usuario. Ninguna de estas filas pasa por la interfaz, porque ninguno
 * de estos requisitos habla de la interfaz.
 */

describe('Spec H / H-R1 · transferir la propiedad', () => {
  it('h1: el owner transfiere a un miembro activo y el rol cambia en las dos filas', async () => {
    const owner = await newUser('h1o'); const gid = await newGroup(owner)
    const otro = await newUser('h1m')
    await admin.from('group_members').insert({ group_id: gid, user_id: otro.id, status: 'active' })

    const { error } = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: otro.id })
    expect(error, 'la transferencia falló').toBeNull()

    expect(await rolDe(gid, owner.id), 'el viejo owner no bajó a member').toEqual([{ role: 'member', status: 'active' }])
    expect(await rolDe(gid, otro.id), 'el nuevo owner no subió').toEqual([{ role: 'owner', status: 'active' }])
    // i3-R2 — Con H-R8 revertido, este caso deja `owner_id` divergente: el estado que `h15 bis`
    // demuestra que el barrido caza, y que pondría rojas a `h15` y a `create-group.test.ts` en toda
    // corrida posterior sin que nada señalara a esta fila.
    limpiarAlTerminar(gid)
  })

  it('h2: transferir a uno mismo, a un pending, o siendo no-owner: 42501', async () => {
    const owner = await newUser('h2o'); const gid = await newGroup(owner)
    const pendiente = await newUser('h2p'); const ajeno = await newUser('h2a')
    await admin.from('group_members').insert({ group_id: gid, user_id: pendiente.id, status: 'pending' })

    const aSiMismo = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: owner.id })
    expect(aSiMismo.error?.code, 'se transfirió a sí mismo').toBe('42501')

    const aPendiente = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: pendiente.id })
    expect(aPendiente.error?.code, 'un pending recibió la propiedad').toBe('42501')

    const deAjeno = await ajeno.client.rpc('transfer_group', { p_group_id: gid, p_user_id: owner.id })
    expect(deAjeno.error?.code, 'un no-miembro transfirió un grupo ajeno').toBe('42501')

    // Y nada cambió: el rechazo no deja estado a medias.
    expect(await rolDe(gid, owner.id)).toEqual([{ role: 'owner', status: 'active' }])
    // La sonda deja el grupo coherente: con su mecanismo revertido, este caso produce justo el
    // estado que el mecanismo impide, y ese estado pone rojas a las guardas de OTRO fichero.
    // Y se afirman las **tres** propiedades, no sólo el recuento: `dejarCoherente` pone
    // `deleted_at: null` en silencio al encontrar un owner, así que mirar sólo `.owners` dejaba
    // pasar un defecto que borrara el grupo conservando su dueño.
    limpiarAlTerminar(gid)
  })

  it('h3: dos transferencias a la vez — una entra y la otra se niega, sin dejar el grupo sin owner', async () => {
    const owner = await newUser('h3o'); const gid = await newGroup(owner)
    const a = await newUser('h3a'); const b = await newUser('h3b')
    await admin.from('group_members').insert([
      { group_id: gid, user_id: a.id, status: 'active' },
      { group_id: gid, user_id: b.id, status: 'active' },
    ])

    const [r1, r2] = await Promise.all([
      owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: a.id }),
      owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id }),
    ])
    const fallos = [r1, r2].filter(r => r.error)
    expect(fallos, 'las dos entraron: el grupo pudo quedar con dos owners').toHaveLength(1)

    /**
     * **La que pierde recibe `42501`, no `23505`, y la spec decía lo contrario.** Medido: el segundo
     * `update` de degradación se bloquea en la fila del owner; cuando la primera transacción
     * confirma, su `where role='owner' and status='active'` se re-evalúa bajo el snapshot nuevo, no
     * encuentra nada, y sale por el `not found`. El índice parcial nunca llega a dispararse en este
     * escenario — su papel es otro: impedir un segundo owner por un camino que no degrade a nadie.
     */
    expect(fallos[0].error?.code, 'el código no es el de la puerta de autoridad').toBe('42501')

    // i3-R4 — la copia byte a byte del predicado que sobrevivió a la iteración 2, que decía haberlas
    // compartido todas. Eran tres, no dos.
    expect(await ownersActivos(gid), 'el grupo no acabó con exactamente un owner activo').toBe(1)
  })
})

describe('Spec H / H-R2 · exactamente un owner activo, hecho cumplir por la base', () => {
  it('h4: la sonda que intenta un segundo owner activo se caza', async () => {
    const owner = await newUser('h4o'); const gid = await newGroup(owner)
    const otro = await newUser('h4m')

    /**
     * §E.2 — La sonda entra con la clave de servicio, **saltándose RLS y saltándose las funciones**:
     * es el único modo de comprobar que lo que rechaza es el índice y no un `if` de plpgsql. Si esto
     * pasara, el invariante viviría sólo en las funciones y cualquier camino futuro lo rompería.
     */
    const { error } = await admin.from('group_members')
      .insert({ group_id: gid, user_id: otro.id, status: 'active', role: 'owner' })
    /**
     * **Y se limpia pase lo que pase, que es el arreglo de un defecto que esta sonda ya causó.**
     * Cuando el índice está, el insert se rechaza y no hay nada que limpiar. Cuando NO está —al
     * revertir el mecanismo para medir el rojo, o sobre una base anterior a la migración—, el insert
     * **entra**, la fila sobrevive al test, y entonces la migración ya no se puede volver a aplicar:
     * `unit/migrations.test.ts` reaplica las doce y el índice aborta con «Key (group_id) is
     * duplicated». Medido: tres grupos envenenados en una sola corrida, y la verja de otro fichero
     * en rojo por culpa de esta fila.
     */
    await admin.from('group_members')
      .update({ status: 'removed' })
      .eq('group_id', gid).eq('user_id', otro.id).eq('role', 'owner')
    expect(error?.code, 'la base aceptó un segundo owner activo').toBe('23505')

    /**
     * Y con el estado no-activo sí se puede: el índice es parcial a propósito, para que un ex-owner
     * expulsado no bloquee al siguiente. Se comprueba con un tercer usuario, porque la clave primaria
     * `(group_id, user_id)` ya no admitiría otra fila del segundo.
     */
    const tercero = await newUser('h4t')
    const conservado = await admin.from('group_members')
      .insert({ group_id: gid, user_id: tercero.id, status: 'removed', role: 'owner' })
    expect(conservado.error, 'el índice bloqueó una fila que no compite por la propiedad').toBeNull()
  })
})

describe('Spec H / H-R3 · borrar es expulsar a todos, el owner incluido', () => {
  it('h5: pone removed en toda fila, pending incluidas, y revoca las invitaciones', async () => {
    const owner = await newUser('h5o'); const gid = await newGroup(owner)
    const activo = await newUser('h5a'); const pendiente = await newUser('h5p')
    await admin.from('group_members').insert([
      { group_id: gid, user_id: activo.id, status: 'active' },
      { group_id: gid, user_id: pendiente.id, status: 'pending' },
    ])
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })

    const { error } = await owner.client.rpc('delete_group', { p_group_id: gid })
    expect(error, 'el borrado falló').toBeNull()

    const estados = await sql<{ status: string }>(
      'select status from public.group_members where group_id=$1 order by status', [gid])
    expect(estados, 'quedó alguien dentro').toEqual([
      { status: 'removed' }, { status: 'removed' }, { status: 'removed' },
    ])

    const vivas = await sql<{ n: string }>(
      'select count(*) as n from public.group_invites where group_id=$1 and revoked_at is null', [gid])
    expect(vivas[0].n, 'quedó una invitación viva sobre un grupo borrado').toBe('0')
    expect(token, 'el escenario no montó su invitación').toBeTruthy()
  })

  it('h6: tras borrar, un ex-miembro con el link NO vuelve a pending', async () => {
    const owner = await newUser('h6o'); const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const invitado = await newUser('h6i')
    await invitado.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: invitado.id, p_decision: 'active' })

    await owner.client.rpc('delete_group', { p_group_id: gid })

    const { data } = await invitado.client.rpc('request_join', { p_token: token })
    expect(data.status, 'el link readmitió a alguien en un grupo muerto').toBe('invalid')
    expect(await rolDe(gid, invitado.id), 'volvió a entrar').toEqual([{ role: 'member', status: 'removed' }])
  })

  it('h8: borrar dos veces no cambia nada, y la segunda no grita', async () => {
    const owner = await newUser('h8o'); const gid = await newGroup(owner)
    await owner.client.rpc('delete_group', { p_group_id: gid })
    const antes = await sql('select user_id, status, decided_at from public.group_members where group_id=$1', [gid])

    const segunda = await owner.client.rpc('delete_group', { p_group_id: gid })
    /**
     * El reintento silencioso es el requisito, no un detalle: la primera llamada puede volver con
     * resultado desconocido —un timeout después de que el servidor la aplicara— y entonces el cliente
     * reintenta. Un `42501` ahí diría «sólo el owner puede borrar» sobre algo que sí funcionó.
     */
    expect(segunda.error, 'la segunda llamada gritó sobre una operación que ya había funcionado').toBeNull()
    const despues = await sql('select user_id, status, decided_at from public.group_members where group_id=$1', [gid])
    expect(despues, 'la segunda llamada movió el estado').toEqual(antes)
  })

  it('h8 bis: quien no es owner no borra, y quien transfirió tampoco', async () => {
    const owner = await newUser('h8bo'); const gid = await newGroup(owner)
    const otro = await newUser('h8bm')
    await admin.from('group_members').insert({ group_id: gid, user_id: otro.id, status: 'active' })

    const deMiembro = await otro.client.rpc('delete_group', { p_group_id: gid })
    expect(deMiembro.error?.code, 'un miembro borró el grupo').toBe('42501')

    await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: otro.id })
    const tras = await owner.client.rpc('delete_group', { p_group_id: gid })
    expect(tras.error?.code, 'el viejo owner siguió pudiendo borrar tras transferir').toBe('42501')
    // i3-R2 — misma razón que en `h1`: esta fila también transfiere.
    limpiarAlTerminar(gid)
  })
})

describe('Spec H / H-R5 · el owner nunca se autoexpulsa — [REGRESIÓN], y hoy nada lo vigilaba', () => {
  /**
   * Existe `e2e/leave.spec.ts` › «el owner no dispone de la acción de salir», pero afirma que **la
   * interfaz no lo ofrece**: el botón está tras `!isOwner` en el cliente. Quitando el
   * `role <> 'owner'` de la función, ese test sigue verde. Estas dos filas atacan la base.
   */
  it('h11: leave_group rechaza al owner', async () => {
    const owner = await newUser('h11o'); const gid = await newGroup(owner)
    const { error } = await owner.client.rpc('leave_group', { p_group_id: gid })
    expect(error?.code, 'el owner salió de su propio grupo y lo dejó huérfano').toBe('42501')
    expect(await rolDe(gid, owner.id)).toEqual([{ role: 'owner', status: 'active' }])
    // La sonda deja el grupo coherente: con su mecanismo revertido, este caso produce justo el
    // estado que el mecanismo impide, y ese estado pone rojas a las guardas de OTRO fichero.
    // Y se afirman las **tres** propiedades, no sólo el recuento: `dejarCoherente` pone
    // `deleted_at: null` en silencio al encontrar un owner, así que mirar sólo `.owners` dejaba
    // pasar un defecto que borrara el grupo conservando su dueño.
    limpiarAlTerminar(gid)
  })

  it('h12: decide_member rechaza al owner sobre sí mismo', async () => {
    const owner = await newUser('h12o'); const gid = await newGroup(owner)
    const { error } = await owner.client.rpc('decide_member', {
      p_group_id: gid, p_user_id: owner.id, p_decision: 'removed',
    })
    expect(error?.code, 'el owner se expulsó a sí mismo').toBe('42501')
    expect(await rolDe(gid, owner.id)).toEqual([{ role: 'owner', status: 'active' }])
  })

  it('h11 bis: y un miembro normal SÍ puede salir — la puerta que se conserva', async () => {
    const owner = await newUser('h11bo'); const gid = await newGroup(owner)
    const otro = await newUser('h11bm')
    await admin.from('group_members').insert({ group_id: gid, user_id: otro.id, status: 'active' })
    const { error } = await otro.client.rpc('leave_group', { p_group_id: gid })
    expect(error, 'un miembro dejó de poder salir').toBeNull()
    expect(await rolDe(gid, otro.id)).toEqual([{ role: 'member', status: 'removed' }])
  })
})

describe('Spec H / iteración 2 · el atajo de idempotencia no habla con quien ya no es miembro', () => {
  it('i2-1: un expulsado no distingue «ya es owner» de «no eres owner»', async () => {
    const a = await newUser('i2a'); const gid = await newGroup(a)
    const b = await newUser('i2b')
    await admin.from('group_members').insert({ group_id: gid, user_id: b.id, status: 'active' })

    await a.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    await b.client.rpc('decide_member', { p_group_id: gid, p_user_id: a.id, p_decision: 'removed' })

    /**
     * A ya no es miembro de nada. Antes de i2-R1 recibía **éxito silencioso** aquí, mientras un
     * desconocido recibía 42501 — y en cuanto B dejara de ser owner, A también. O sea un oráculo de
     * un bit sobre «¿sigue B siendo el owner activo de este grupo?» en manos de un expulsado. La
     * lista de hard fails dice con estas palabras que `removed` cuenta como no-miembro.
     */
    const expulsado = await a.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    expect(expulsado.error?.code,
      'un expulsado sigue pudiendo preguntarle cosas al grupo').toBe('42501')

    const ajeno = await newUser('i2c')
    const desconocido = await ajeno.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    expect(desconocido.error?.code,
      'el desconocido debe recibir exactamente lo mismo').toBe(expulsado.error?.code)
  })

  it('i2-1 bis: y quien sí hizo la transferencia conserva su reintento silencioso', async () => {
    const a = await newUser('i2d'); const gid = await newGroup(a)
    const b = await newUser('i2e')
    await admin.from('group_members').insert({ group_id: gid, user_id: b.id, status: 'active' })
    await a.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    // A sigue dentro como `member`/`active`: su reintento tras un resultado desconocido no grita.
    const reintento = await a.client.rpc('transfer_group', { p_group_id: gid, p_user_id: b.id })
    expect(reintento.error, 'la acotación se llevó por delante la idempotencia').toBeNull()
  })

  it('i2-2: la base rechaza role=owner con status de espera o rechazo', async () => {
    const owner = await newUser('i2f'); const gid = await newGroup(owner)
    const otro = await newUser('i2g')
    /**
     * §D.2 — El invariante en la base, no parcheado en cada escritor. Esta forma era representable y
     * además **muerta**: una fila `owner`+`pending` no se puede aprobar —el índice parcial rechaza el
     * segundo owner activo— ni rechazar, porque `decide_member` no toca filas de owner. Nadie podía
     * sacarla de ahí.
     */
    const pendiente = await admin.from('group_members')
      .insert({ group_id: gid, user_id: otro.id, status: 'pending', role: 'owner' })
    expect(pendiente.error?.code, 'la base aceptó un owner en espera').toBe('23514')

    const rechazado = await admin.from('group_members')
      .insert({ group_id: gid, user_id: otro.id, status: 'rejected', role: 'owner' })
    expect(rechazado.error?.code, 'la base aceptó un owner rechazado').toBe('23514')

    // Y `owner` + `removed` sigue siendo legítima: es lo que deja un grupo borrado.
    const borrado = await admin.from('group_members')
      .insert({ group_id: gid, user_id: otro.id, status: 'removed', role: 'owner' })
    expect(borrado.error, 'la restricción se llevó por delante la forma legítima').toBeNull()
  })
})

describe('Spec H / H-R8 · las dos fuentes de la propiedad no pueden divergir', () => {
  /**
   * i1-R4 — **Una sola definición del barrido, y la sonda ataca ÉSA.** La versión anterior tenía el
   * barrido escrito dos veces: el de h15 y una copia dentro de su sonda. Debilitando el primero, la
   * sonda seguía verde — o sea que no probaba la guarda, probaba su gemela.
   */
  const divergentes = (soloEste?: string) => sql<{ id: string }>(
    `select g.id from public.groups g
      where ($1::uuid is null or g.id = $1::uuid)
        and not exists (select 1 from public.group_members m
                         where m.group_id = g.id and m.user_id = g.owner_id
                           and m.role = 'owner' and m.status = 'active')
        and exists (select 1 from public.group_members m
                     where m.group_id = g.id and m.role = 'owner' and m.status = 'active')`,
    [soloEste ?? null])

  it('h15: ningún grupo de la base tiene owner_id divergente de su fila de owner', async () => {
    const owner = await newUser('h15o'); const gid = await newGroup(owner)
    const otro = await newUser('h15m')
    await admin.from('group_members').insert({ group_id: gid, user_id: otro.id, status: 'active' })
    /**
     * **La transferencia tiene que haber ocurrido, y se afirma.** Sin esta línea la fila pasaba
     * vacuamente: medido al revertir el mecanismo, `transfer_group` no existía, la llamada devolvía
     * error, el barrido corría sobre una base donde nadie había transferido nada y salía verde. Un
     * barrido de ausencia sobre un escenario que no se montó no dice nada.
     */
    const t = await owner.client.rpc('transfer_group', { p_group_id: gid, p_user_id: otro.id })
    expect(t.error, 'la transferencia no ocurrió: el barrido de abajo no mide nada').toBeNull()

    expect(await divergentes(), 'hay grupos donde owner_id y el rol dicen cosas distintas').toEqual([])
  })

  it('h15 bis: la sonda — un grupo torcido a mano se caza', async () => {
    const owner = await newUser('h15bo'); const gid = await newGroup(owner)
    const otro = await newUser('h15bm')
    await admin.from('group_members').insert({ group_id: gid, user_id: otro.id, status: 'active' })

    /**
     * §E.2 — El barrido de arriba sobre una base sana no distingue «detecta» de «no mira nada». Esto
     * tuerce las dos fuentes con la clave de servicio y exige que el mismo barrido lo encuentre.
     */
    await admin.from('groups').update({ owner_id: otro.id }).eq('id', gid)
    try {
      expect((await divergentes(gid)).map(r => r.id),
        'el barrido no caza una divergencia puesta a mano').toEqual([gid])
    } finally {
      /**
       * **`finally`, y no una línea detrás del `expect`.** Así estaba, y un fallo dejaba `owner_id`
       * torcido para siempre: el barrido global de h15 se pondría rojo en toda corrida futura por
       * culpa de esta sonda. Es el defecto que h4 arregló en la iteración base y que su hermana
       * heredó sin arreglar.
       */
      await admin.from('groups').update({ owner_id: owner.id }).eq('id', gid)
    }
    expect(await divergentes(), 'la sonda dejó la base torcida').toEqual([])
  })
})
