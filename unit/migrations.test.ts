import { describe, it, expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'

/**
 * J11 / DoD 46 — la constitución (C) exige migraciones idempotentes. Se
 * comprueba reaplicándolas sobre la base ya migrada: un `db reset` parcial, un
 * replay o una reejecución las volvería a pasar por aquí.
 */
/**
 * L4 — se reaplica DENTRO de una transaccion que se revierte. Medido antes del
 * cambio: reaplicar `000100` por separado deshacia la cota de TTL de K4, y
 * `000400` deshacia el acotado de K6. Comprobar la idempotencia degradaba el
 * entorno autoritativo, y una tanda interrumpida lo dejaba sin endurecer en
 * silencio.
 */
/**
 * Spec G2 / iteración 1 · i1-R7 — **Con cota de cerrojo, para que el rojo nombre su causa.**
 *
 * Esta fila salió roja una vez durante el ciclo del 2026-09-20 y se anotó como «intermitente». Es
 * peor que eso: es **determinista dada contención**, y la revisión lo reprodujo a la primera.
 * `base.sql` hace `drop policy`, que toma `AccessExclusiveLock` sobre `public.items`; el rol
 * `postgres` no tiene `lock_timeout` ni `statement_timeout`; y el único límite era el `testTimeout`
 * de vitest. Así que cualquier cosa que sostenga un `AccessShareLock` sobre `items` —`pnpm dev`, un
 * contexto de Playwright, Studio abierto— hace que la fila agote el tiempo **con el nombre de la
 * idempotencia**, que es mirar al sitio equivocado.
 *
 * Con la cota, el rojo dice «cerrojo» y tarda dos segundos en decirlo.
 */
function apply(sqlText: string) {
  execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
    { input: `begin;\nset local lock_timeout = '2s';\n${sqlText}\nrollback;\n`,
      stdio: ['pipe', 'pipe', 'pipe'] })
}

function scalar(query: string): string {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
    '-d', 'postgres', '-tAc', query], { encoding: 'utf8' }).trim()
}

/**
 * Iteración 3 de G2 · i3-R8 / i3-8 — **la cota tenía razón y no tenía guarda.** La cota de cerrojo
 * entró en la iteración 1 con una medición a mano, y nada se ponía rojo si alguien la quitaba: la
 * fila volvería a agotar el `testTimeout` de vitest bajo el nombre de la idempotencia, que es
 * exactamente el defecto que la cota vino a arreglar. Es §E.2: toda guarda viaja con una sonda.
 *
 * Qué la pone roja: quitar `set local lock_timeout = '2s'` de `apply`. Sin la cota esto no falla en
 * dos segundos — espera al cerrojo hasta que vitest corta— y ni el mensaje ni el tiempo se cumplen.
 * Medido con la cota fuera: 36,8 s y `Test timed out in 20000ms`, sin una palabra sobre cerrojos.
 */
describe('i3-8 la cota de cerrojo hace que el rojo nombre su causa', () => {
  it('con un AccessShareLock sostenido, falla nombrando el cerrojo y dentro de la cota', async () => {
    /**
     * **La conexión que sostiene el cerrojo se cierra en la base, no matando su envoltorio.** Matar
     * el `docker exec` con SIGKILL deja el `psql` de dentro del contenedor vivo con su `pg_sleep`, y
     * el cerrojo sigue tomado: medido, eso puso rojas las **siete** filas de idempotencia de este
     * mismo fichero, cada una agotando la cota de 2 s. Una sonda que rompe a sus vecinas no vale,
     * por más que ella pase. Se marca con `application_name` para poder cerrarla por identidad y no
     * por parecido de su consulta.
     */
    const ETIQUETA = 'sonda-cerrojo-i3-8'
    const tenedor = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${ETIQUETA}`,
      'supabase_db_super', 'psql', '-U', 'postgres',
      '-d', 'postgres', '-q', '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    tenedor.stdin.end('begin; lock table public.items in access share mode; select pg_sleep(30); rollback;\n')
    try {
      // No se supone que el cerrojo ya está tomado: se espera a verlo en el catálogo.
      const tomado = async () => {
        for (let i = 0; i < 100; i++) {
          const n = scalar(`select count(*) from pg_locks l join pg_class c on c.oid = l.relation
            where c.relname = 'items' and l.mode = 'AccessShareLock' and l.granted`)
          if (Number(n) > 0) return true
          await new Promise(r => setTimeout(r, 50))
        }
        return false
      }
      expect(await tomado(), 'el cerrojo no llegó a tomarse: la sonda no monta su escenario').toBe(true)

      const t0 = Date.now()
      let salida = ''
      try {
        apply('lock table public.items in access exclusive mode;')
      } catch (e) {
        const err = e as { stderr?: Buffer | string }
        salida = String(err.stderr ?? e)
      }
      const ms = Date.now() - t0

      expect(salida, 'el fallo no nombró el cerrojo: mira al sitio equivocado').toMatch(/lock timeout/i)
      expect(ms, 'tardó más que la cota: entonces no hay cota').toBeLessThan(8000)
    } finally {
      // Se cierra en la base y se **espera a verlo cerrado**: devolver el control con el cerrojo
      // todavía tomado es lo que rompía a las vecinas.
      scalar(`select count(pg_terminate_backend(pid)) from pg_stat_activity
        where application_name = '${ETIQUETA}'`)
      tenedor.kill('SIGKILL')
      for (let i = 0; i < 100; i++) {
        const n = scalar(`select count(*) from pg_locks l join pg_class c on c.oid = l.relation
          join pg_stat_activity a on a.pid = l.pid
          where c.relname = 'items' and a.application_name = '${ETIQUETA}'`)
        if (Number(n) === 0) break
        await new Promise(r => setTimeout(r, 50))
      }
    }
  })
})

describe('J11 las migraciones se pueden reaplicar', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

  it('hay migraciones que comprobar', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // Sin exclusiones: la versión anterior abandonaba el fichero entero al ver un
  // `create table`, lo que se saltaba en silencio la migración base — la más
  // grande — y por tanto no podía denunciar que fallaba en su primera sentencia.
  it.each(files)('%s se reaplica sin error', (file) => {
    expect(() => apply(readFileSync(join(DIR, file), 'utf8'))).not.toThrow()
  })

  it('la base está entre las que se comprueban', () => {
    expect(files.some(f => f.includes('base'))).toBe(true)
  })

  // L4 / DoD 66 — la comprobación no puede dejar la base más floja que como la
  // encontró. Estas dos son justo las que se perdían al reaplicar suelto.
  it('tras la comprobación, la cota de TTL de K4 sigue en pie', () => {
    const src = scalar("select prosrc from pg_proc where proname='create_invite'")
    expect(src).toContain('least(greatest')
  })

  it('tras la comprobación, owns_group_of sigue acotada a pending/active', () => {
    const src = scalar("select prosrc from pg_proc where proname='owns_group_of'")
    expect(src).toContain("'pending'")
    expect(src).toContain("'active'")
  })
})

/**
 * Spec I — **Las migraciones se aplican sobre una base VACÍA, que es lo que J11 no puede comprobar.**
 *
 * J11 las reaplica sobre la base que ya existe, así que una **referencia hacia adelante** —un `grant`
 * sobre una función que el mismo fichero crea más abajo— encuentra la función ya creada de una
 * aplicación anterior y nunca falla. Es estructural: ese test no puede ver esta clase de defecto.
 *
 * Y no es hipotético. `20260920000100_transferir_borrar.sql` llevaba exactamente eso y **reventó el
 * primer `db push` contra el proyecto hospedado**, donde la base estaba vacía:
 * `ERROR: function public.delete_group(uuid) does not exist (SQLSTATE 42883)`. En local llevaba días
 * en verde, porque su primera versión definía la función arriba y al quitar el duplicado los `grant`
 * se quedaron donde estaban — con la función ya creada en la base de nadie más que de aquí.
 *
 * La base de trabajo **no se toca**: se crea una aparte y se destruye al salir. El arranque es un
 * sustituto de la infraestructura de Supabase y vale para lo que esta fila mira —el orden y las
 * dependencias entre sentencias—, no para el comportamiento de RLS contra el auth real.
 */
/**
 * El sustituto de la infraestructura de Supabase en una base recién creada. **Una sola
 * declaración**, porque ahora la usan dos filas: si cada una llevara su copia, la que se
 * escriba después heredaría un arranque que ya no coincide con el de al lado.
 *
 * Vale para lo que estas filas miran —el orden y las dependencias entre sentencias— y no para
 * el comportamiento de RLS contra el auth real, que se mide con el token del usuario en
 * `unit/items-crud.test.ts`.
 */
/**
 * i2-R8 — Una sola copia. Estaba escrito dos veces, con la única diferencia de `-t -A`, que
 * sólo afecta al formato de lo que imprime; las dos filas lo quieren, y la que no lo pedía no
 * leía ninguna salida.
 */
const psql = (db: string, args: string[], input?: string) =>
  execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, ...args],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

const ARRANQUE = `
  create schema if not exists auth;
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  -- La columna raw_user_meta_data no estaba, y el trigger real handle_new_user la lee: sin
  -- ella, insertar un usuario revienta con «record new has no field». El sustituto tiene que
  -- parecerse a la tabla de verdad en lo que el producto toca, no sólo en la clave.
  create table if not exists auth.users (id uuid primary key, email text,
    raw_user_meta_data jsonb default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create publication supabase_realtime;
`

/**
 * Spec J / j3, j4 — **La migración de la cantidad se aplica sobre una base SUCIA, y normaliza
 * antes de restringir.**
 *
 * Es la propiedad que J-R1 compra, y la que nada ejercitaba: la fila de arriba aplica las
 * migraciones sobre una base **vacía**, donde no hay ninguna cantidad que normalizar, así que
 * un `add constraint` sin su `update` delante pasaría por verde. Medido contra la base local
 * (2.762 cantidades por decidir): **sin el `update`, el `add constraint` es rechazado.** En el
 * proyecto hospedado hay cero, así que una migración escrita sólo para allí habría pasado todas
 * las comprobaciones y reventado aquí.
 *
 * Se siembra con las formas **medidas**, no inventadas, y una de ellas es la que el usuario
 * corrigió: `1.5` acaba **nula**, no en `1`. Convertirla en `1` es inventar otro dato, por el
 * mismo motivo que `299` no se trunca a `29`.
 */
describe('Spec J · la migración de la cantidad sobre datos sucios', () => {
  it('j3/j4: normaliza y después restringe, sobre filas que no cumplen', () => {
    const base = `prueba_cantidad_${process.pid}`

    const LA_NUEVA = '20260921000200_cantidad_numero.sql'
    const todas = readdirSync(DIR).filter(x => x.endsWith('.sql')).sort()
    expect(todas, `${LA_NUEVA} no está: este test mide otra cosa`).toContain(LA_NUEVA)

    psql('postgres', ['-c', `drop database if exists ${base}`])
    psql('postgres', ['-c', `create database ${base}`])
    try {
      psql(base, ['-f', '-'], ARRANQUE)
      // Todo lo anterior a la migración de la cantidad: aquí la columna todavía es texto libre.
      for (const f of todas.filter(x => x < LA_NUEVA))
        psql(base, ['-f', '-'], readFileSync(join(DIR, f), 'utf8'))

      // Las formas medidas en la base real, con el veredicto que les toca.
      const SUCIAS: [string, string | null][] = [
        ['2 briks', '2'], ['2 kg', '2'], ['12 unidades', '12'],
        ['1.5', null], ['1,5', null], ['2, briks', '2'],
        ['299', null], ['165', null], ['-5', null], ['doce', null], ['CANT-B', null],
        ['q'.repeat(50), null], ['99999999999999999999', null],
        ['7', '7'], ['99', '99'],
      ]
      psql(base, ['-f', '-'], `
        insert into auth.users(id, email) values
          ('11111111-1111-1111-1111-111111111111', 'j@example.test');
        -- El perfil lo crea el trigger handle_new_user al insertar el usuario: crearlo aquí
        -- otra vez choca con su clave, y es la señal de que el trigger corrió.
        insert into public.groups(id, name, owner_id) values
          ('22222222-2222-2222-2222-222222222222', 'G',
           '11111111-1111-1111-1111-111111111111');
        ${SUCIAS.map(([v], i) => `insert into public.items(group_id, name, quantity, created_by)
          values ('22222222-2222-2222-2222-222222222222', 'p${i}',
                  ${v === null ? 'null' : `$sucia$${v}$sucia$`},
                  '11111111-1111-1111-1111-111111111111');`).join('\n')}
      `)

      // Y ahora la migración, sobre esas filas. Si el `update` no fuera delante, esto lanza.
      expect(() => psql(base, ['-f', '-'], readFileSync(join(DIR, LA_NUEVA), 'utf8')),
        'la migración no aplica sobre datos sucios: le falta normalizar antes de restringir')
        .not.toThrow()

      // j3 — el veredicto de cada forma, una por una. Se compara por nombre y no por posición:
      // un orden de filas es un detalle del motor, y hacerlo parte de la afirmación convierte
      // un cambio de plan en un fallo de la migración.
      const veredictos = Object.fromEntries(psql(base, ['-c',
        `select name || '=' || coalesce(quantity, '<null>') from public.items`])
        .trim().split('\n').map(l => l.split('=') as [string, string]))
      expect(veredictos, 'la migración no dejó las cantidades donde la regla dice').toEqual(
        Object.fromEntries(SUCIAS.map(([, esperado], i) => [`p${i}`, esperado ?? '<null>'])))

      /**
       * i10 — **Y aplica otra vez sobre su propio resultado, y sobre una definición previa
       * INCOMPATIBLE.** La segunda es la que faltaba: con un `items_quantity_num` más
       * estrecho ya puesto, el `update` del paso 1 moría —«violates check constraint»— y la
       * migración no llegaba a tocar nada. Era falsa la propiedad que su cabecera reclama.
       */
      expect(() => psql(base, ['-f', '-'], readFileSync(join(DIR, LA_NUEVA), 'utf8')),
        'la migración no es reaplicable sobre su propio resultado').not.toThrow()

      /**
       * La definición previa **incompatible** no es cualquiera, y se eligió midiendo en vez
       * de suponiendo: una más ancha sobrevive, porque un `check` cuya expresión da NULL se
       * considera satisfecho y la migración sólo produce nulos y valores de 1 a 99. La que
       * rompe es la que **prohíbe el nulo** —`quantity is not null and …`—, que es la forma
       * que tendría una versión anterior de esta misma restricción con la cantidad
       * obligatoria. Medido: «violates check constraint … Failing row contains (null)».
       */
      psql(base, ['-f', '-'], `
        alter table public.items drop constraint if exists items_quantity_num;
        update public.items set quantity = '5' where quantity is null;
        update public.items set quantity = '299' where name = 'p0';
        alter table public.items add constraint items_quantity_num
          check (quantity is not null and quantity ~ '^[1-9][0-9]{0,2}$');
      `)
      expect(() => psql(base, ['-f', '-'], readFileSync(join(DIR, LA_NUEVA), 'utf8')),
        'la migración muere si ya hay un check incompatible: depende del estado de la base')
        .not.toThrow()
      expect(psql(base, ['-c', `select count(*) from pg_constraint
        where conrelid = 'public.items'::regclass and conname = 'items_quantity_num'`]).trim(),
        'quedó más de una definición, o ninguna').toBe('1')

      // j4 — y la restricción quedó puesta y muerde.
      expect(() => psql(base, ['-c', `insert into public.items(group_id, name, quantity, created_by)
        values ('22222222-2222-2222-2222-222222222222', 'muerde', '2 briks',
                '11111111-1111-1111-1111-111111111111')`]),
        'la restricción no está puesta: la migración normalizó y no restringió')
        .toThrow()
    } finally {
      psql('postgres', ['-c', `drop database if exists ${base}`])
    }
  }, 120_000)
})

describe('Spec I · las migraciones aplican sobre una base vacía', () => {
  it('todas, en orden, desde cero', () => {
    const base = `prueba_migraciones_${process.pid}`

    psql('postgres', ['-c', `drop database if exists ${base}`])
    psql('postgres', ['-c', `create database ${base}`])
    try {
      psql(base, ['-f', '-'], ARRANQUE)
      /**
       * i1-R10 — **Cuántas son se cuenta, no se escribe en el título.** Decía «las 15» con
       * dieciséis en el directorio, y nada lo afirmaba: es la misma deriva de cifras que la
       * guarda del checkpoint existe para impedir. El suelo es lo que hay hoy; si alguien
       * borra una migración, esto se pone rojo y hay que mirarlo.
       */
      const ficheros = readdirSync(DIR).filter(x => x.endsWith('.sql')).sort()
      expect(ficheros.length, 'desaparecieron migraciones del directorio').toBeGreaterThanOrEqual(16)
      for (const f of ficheros) {
        expect(() => psql(base, ['-f', '-'], readFileSync(join(DIR, f), 'utf8')),
          `${f} no aplica sobre una base vacía: depende de estado que sólo existe aquí`).not.toThrow()
      }
    } finally {
      // Se destruye pase lo que pase: una base huérfana por pasada es la cicatriz de esta spec.
      psql('postgres', ['-c', `drop database if exists ${base}`])
    }
  }, 120_000)
})
