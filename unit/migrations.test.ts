import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
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
function apply(sqlText: string) {
  execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
    { input: `begin;\n${sqlText}\nrollback;\n`, stdio: ['pipe', 'pipe', 'pipe'] })
}

function scalar(query: string): string {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_super', 'psql', '-U', 'postgres',
    '-d', 'postgres', '-tAc', query], { encoding: 'utf8' }).trim()
}

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
