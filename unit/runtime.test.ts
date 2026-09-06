import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// R0 — el Node local (v25) no es el de Vercel (24 LTS). Sin fijarlo, la
// divergencia se descubre en el deploy.
describe('R0 runtime fijado', () => {
  it('.nvmrc declara Node 24', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toMatch(/^24\./)
  })
  it('package.json declara engines.node en 24', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.engines?.node).toMatch(/24/)
  })
})
