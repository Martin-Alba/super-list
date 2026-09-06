import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

// R17 — sin el fichero, el primer commit se lleva las claves de Supabase,
// y eso no se deshace borrándolas después.
const ignored = (p: string) => {
  try { execFileSync('git', ['check-ignore', '-q', '--no-index', p]); return true }
  catch { return false }
}

describe('R17 fichero de exclusión', () => {
  it.each(['node_modules/x', '.next/x', '.env.local', 'test-results/t/trace.zip', 'playwright-report/index.html'])('ignora %s', (p) => {
    expect(ignored(p)).toBe(true)
  })
  it('NO ignora .env.example — es la plantilla que debe viajar en el repo', () => {
    expect(ignored('.env.example')).toBe(false)
  })
})
