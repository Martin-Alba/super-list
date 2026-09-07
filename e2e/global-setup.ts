/**
 * Playwright espera a que el servidor responda, pero eso sólo prueba que el
 * proceso está vivo: el primer render todavía paga el arranque en frío
 * (conexión a Supabase, primer RSC). Sin calentarlo, el primer test de la tanda
 * compite contra ese coste y agota su espera — verde en aislamiento, rojo en
 * suite, que es la peor clase de test.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appOrigin, esHostLocal } from './appOrigin'

export default async function globalSetup() {
  const base = appOrigin()

  for (const path of ['/', '/login']) {
    // J15 — la fecha límite es POR RUTA. Compartida, si `/` consumía los 60 s,
    // `/login` no se intentaba nunca y el setup igualmente devolvía éxito.
    const deadline = Date.now() + Number(process.env.E2E_WARMUP_MS ?? 60_000)
    let warmed = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) })
        if (res.ok) { await res.text(); warmed = true; break }
      } catch {
        // El servidor aún no atiende; se reintenta hasta la fecha límite.
      }
      await new Promise(r => setTimeout(r, 100))
    }
    // Si no se calentó, los 18 tests fallarían por un motivo que no es el suyo.
    if (!warmed) throw new Error(`No se pudo calentar ${base}${path}`)
  }

  await calentarRealtime()
}

/**
 * U2 — El servicio de realtime arranca su tenant con la primera suscripción, y
 * tras un `supabase stop/start` tarda en empezar a ENTREGAR: `SUBSCRIBED` llega,
 * los eventos no.
 *
 * La versión anterior esperaba `SUBSCRIBED` y dormía dos segundos. Eso no prueba
 * nada, porque el síntoma documentado es exactamente que `SUBSCRIBED` llega sin
 * entrega. Se usa el centinela que este repositorio ya tenía en
 * `unit/expel-event.test.ts`: se escribe una fila y se espera a **verla**.
 */
async function calentarRealtime() {
  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  )

  const centinelaId = await bancoDeCalentamiento(admin)

  const recibidos: unknown[] = []
  const canal = admin.channel('calentamiento')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' },
      p => recibidos.push(p))

  const suscrito = await new Promise<boolean>(resolve => {
    const plazo = setTimeout(() => resolve(false), 30_000)
    canal.subscribe(estado => {
      if (estado === 'SUBSCRIBED') { clearTimeout(plazo); resolve(true) }
      if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT') { clearTimeout(plazo); resolve(false) }
    })
  })
  if (!suscrito) throw new Error('el servicio de realtime no aceptó una suscripción')

  /**
   * Centinela: se ESCRIBE hasta ver un evento. `SUBSCRIBED` no basta — el
   * síntoma documentado es justamente que llega sin que se entregue nada.
   *
   * W1 — Esto creaba un usuario y un grupo por pasada y los borraba después, con
   * `DELETE` físico sobre `items` y `group_members`. Las dos están en la
   * publicación `supabase_realtime`, así que era una violación del *hard fail*
   * de la constitución, cometida por el propio arnés que la hace cumplir; y
   * cascadeaba por dos caminos más, `groups` y `auth.users`.
   *
   * Ahora el banco es **durable** y el centinela se **actualiza**: sin altas ni
   * bajas no hay nada que limpiar, y el `UPDATE` entrega igual de bien.
   */
  try {
    const limite = Date.now() + 30_000
    let vuelta = 0
    while (recibidos.length === 0 && Date.now() < limite) {
      const { error } = await admin.from('items')
        .update({ quantity: (vuelta++ % 9) + 1 }).eq('id', centinelaId)
      if (error) throw new Error(`no se pudo tocar el centinela: ${error.message}`)
      await new Promise(r => setTimeout(r, 400))
    }
    if (recibidos.length === 0) throw new Error('realtime aceptó la suscripción pero no entrega eventos')
  } finally {
    await admin.removeChannel(canal)
  }
}

/**
 * X2 — Devuelve el id del usuario del banco, creándolo sólo si no está. Es la
 * mitad que faltaba de la idempotencia: sin esto, un banco a medias bloqueaba
 * todas las pasadas siguientes de forma permanente.
 */
async function usuarioDelBanco(admin: Admin): Promise<string> {
  const { data: creado, error } = await admin.auth.admin.createUser({
    email: CORREO_BANCO, email_confirm: true,
  })
  if (!error && creado?.user) return creado.user.id

  const yaExiste = /already.*regist/i.test(error?.message ?? '')
  if (!yaExiste) throw new Error(`no se pudo crear el usuario del banco: ${error?.message}`)

  /**
   * Y1 — Aquí había un `listUsers({ perPage: 1000 })`, y **no funciona**: la
   * base tiene 7.610 usuarios ordenados por fecha descendente y el del banco
   * está en la posición 1429. Mi prueba de recuperación pasó porque el usuario
   * acababa de crearse; con +43 usuarios por pasada (deuda 17) caducó a las ~24
   * pasadas, y a partir de ahí el arranque quedaba bloqueado para siempre con un
   * mensaje que volvía a nombrar la causa equivocada.
   *
   * Se pregunta a `auth.users`, que es donde está la verdad, en vez de paginar
   * a ciegas por una API que ordena por otra cosa.
   */
  /**
   * Z9 — Sin `DATABASE_URL`, `new Pool({connectionString: undefined})` cae a
   * `PGHOST`/`PGUSER` y se conecta a lo que haya en 5432: medido, fallaba con
   * `3D000 database "martinalba" does not exist`, o sea nombrando la causa
   * equivocada — el defecto exacto que Y1 decía haber quitado. Y la parada en
   * seco de X6 miraba `NEXT_PUBLIC_SUPABASE_URL` pero nunca esta conexión.
   */
  const cadena = comprobarBaseLocal()

  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: cadena })
  try {
    const { rows } = await pool.query<{ id: string }>(
      'select id from auth.users where email = $1 limit 1', [CORREO_BANCO])
    if (!rows[0]) throw new Error(`el usuario del banco no está en auth.users: ${CORREO_BANCO}`)
    return rows[0].id
  } finally {
    await pool.end()
  }
}

/**
 * Z9 — Se comprueba **siempre**, no sólo en la rama de recuperación: una guarda
 * que sólo corre cuando ya hay un problema no impide nada. Sin `DATABASE_URL`,
 * `new Pool` cae a `PGHOST`/`PGUSER` y se conecta a lo que haya en 5432 —
 * medido, fallaba con `3D000` nombrando la causa equivocada.
 */
function comprobarBaseLocal(): string {
  const cadena = process.env.DATABASE_URL
  if (!cadena) throw new Error('falta DATABASE_URL: sin ella el arnés iría a una base cualquiera')
  const host = new URL(cadena).hostname
  if (!esHostLocal(host)) {
    throw new Error(`DATABASE_URL apunta a ${host}, que no es local: el arnés sólo trabaja contra el stack local`)
  }
  return cadena
}

/** Identidades fijas: el banco se reutiliza entre pasadas, no se recrea. */
const CORREO_BANCO = 'calentamiento@example.test'
const NOMBRE_BANCO = 'calentamiento-realtime'
const CENTINELA = 'centinela-calentamiento'

type Admin = SupabaseClient

/**
 * W1 / DoD 60 — Devuelve el grupo de calentamiento y su ítem centinela, creando
 * lo que falte. Es idempotente: dos arranques seguidos no añaden ni una fila.
 */
async function bancoDeCalentamiento(admin: Admin): Promise<string> {
  /**
   * X6 — El banco es DURABLE y con identidad predecible. Contra un proyecto
   * hospedado eso sería una cuenta permanente creada por el arnés, así que aquí
   * se para en seco: `Authoritative environment` es el stack local, y apuntar
   * esto a otro sitio es cambiar una variable.
   */
  comprobarBaseLocal()
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname
  if (!esHostLocal(host)) {
    throw new Error(`el banco de calentamiento sólo se monta contra Supabase local, no contra ${host}`)
  }

  // X2 — el error se comprobaba en unos sitios y se descartaba aquí. Con dos
  // grupos homónimos —`groups.name` no es único— `maybeSingle()` devuelve
  // `PGRST116` y caía en la rama de creación, que fallaba para siempre.
  const { data: existente, error: errBusca } = await admin
    .from('groups').select('id, owner_id').eq('name', NOMBRE_BANCO)
    .order('created_at', { ascending: true }).limit(1).maybeSingle()
  if (errBusca) throw new Error(`no se pudo buscar el grupo del banco: ${errBusca.message}`)

  let grupoId = existente?.id as string | undefined
  let ownerId = existente?.owner_id as string | undefined

  if (!grupoId) {
    /**
     * X2 — Antes esto creaba el usuario a secas. Si el grupo faltaba y el
     * usuario existía —el banco a medias—, `createUser` devolvía "already been
     * registered" y **todas** las pasadas siguientes morían en el setup, con un
     * mensaje que nombraba la causa equivocada, hasta cirugía manual. El
     * comentario de abajo prometía reparar "el banco que quedó a medias" y sólo
     * cubría una de las dos direcciones.
     */
    ownerId = await usuarioDelBanco(admin)

    const { data: grupoNuevo, error: errGrupo } = await admin
      .from('groups').insert({ name: NOMBRE_BANCO, owner_id: ownerId! }).select('id').single()
    if (errGrupo || !grupoNuevo) throw new Error(`no se pudo crear el grupo del banco: ${errGrupo?.message}`)
    grupoId = grupoNuevo.id
  }

  /**
   * La autoridad sobre quién manda en un grupo es `group_members.role`, no
   * `groups.owner_id` (deuda 8). Insertar sólo el grupo dejaba uno **sin
   * propietario activo**, y `unit/create-group.test.ts` lo cazó: es la clase de
   * invariante que un arnés no puede romper por atajar. Idempotente, así que
   * también repara el banco que quedó a medias.
   */
  const { error: errMiembro } = await admin.from('group_members')
    .upsert({ group_id: grupoId!, user_id: ownerId!, role: 'owner', status: 'active' },
      { onConflict: 'group_id,user_id' })
  if (errMiembro) throw new Error(`no se pudo asentar al propietario del banco: ${errMiembro.message}`)

  const { data: centinela, error: errCent } = await admin
    .from('items').select('id').eq('group_id', grupoId!).eq('name', CENTINELA)
    .is('deleted_at', null).limit(1).maybeSingle()
  if (errCent) throw new Error(`no se pudo buscar el centinela: ${errCent.message}`)

  let centinelaId = centinela?.id as string | undefined
  if (!centinelaId) {
    const { data: nuevo, error } = await admin.from('items')
      .insert({ group_id: grupoId!, name: CENTINELA, created_by: ownerId! }).select('id').single()
    if (error || !nuevo) throw new Error(`no se pudo crear el centinela: ${error?.message}`)
    centinelaId = nuevo.id
  }

  return centinelaId!
}
