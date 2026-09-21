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
describe('Spec I · las migraciones aplican sobre una base vacía', () => {
  it('las 15, en orden, desde cero', () => {
    const base = `prueba_migraciones_${process.pid}`
    const psql = (db: string, args: string[], input?: string) =>
      execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...args],
        { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

    psql('postgres', ['-c', `drop database if exists ${base}`])
    psql('postgres', ['-c', `create database ${base}`])
    try {
      psql(base, ['-f', '-'], `
        create schema if not exists auth;
        create schema if not exists extensions;
        create extension if not exists pgcrypto with schema extensions;
        create table if not exists auth.users (id uuid primary key, email text);
        create or replace function auth.uid() returns uuid language sql stable as
          $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
        create publication supabase_realtime;
      `)
      for (const f of readdirSync(DIR).filter(x => x.endsWith('.sql')).sort()) {
        expect(() => psql(base, ['-f', '-'], readFileSync(join(DIR, f), 'utf8')),
          `${f} no aplica sobre una base vacía: depende de estado que sólo existe aquí`).not.toThrow()
      }
    } finally {
      // Se destruye pase lo que pase: una base huérfana por pasada es la cicatriz de esta spec.
      psql('postgres', ['-c', `drop database if exists ${base}`])
    }
  }, 120_000)
})
