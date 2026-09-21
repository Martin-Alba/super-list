import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { newUser, newGroup } from './helpers'

const anon = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

// I3 — medido antes del cambio: un cliente sin sesión recibía
// {"valid":true,"group_name":"Familia Alba"}. El nombre es un metadato del
// grupo, y A.1 lo protege igual que los ítems o los miembros.
describe('I3 la vista previa no revela metadatos del grupo', () => {
  it('un cliente sin sesión sabe si el link sirve, y nada más', async () => {
    const owner = await newUser('prev')
    const gid = await newGroup(owner, 'Familia Alba')
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })

    const { data, error } = await anon().rpc('invite_preview', { p_token: token })

    expect(error).toBeNull()
    expect(data.valid).toBe(true)
    expect(Object.keys(data)).toEqual(['valid'])
    expect(JSON.stringify(data)).not.toContain('Familia Alba')
  })

  it('un token inservible sólo se distingue en la validez', async () => {
    const { data } = await anon().rpc('invite_preview', { p_token: 'no-existe' })
    expect(data).toEqual({ valid: false })
  })
})
