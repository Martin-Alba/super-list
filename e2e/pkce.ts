import { createServerClient } from '@supabase/ssr'
import { admin } from './fixtures'
import { appOrigin, appHostname } from './appOrigin'

/**
 * N4 — Un flujo PKCE **real** sin pasar por Google.
 *
 * El tramo de Google no se puede automatizar (credenciales de un tercero), pero
 * el flujo PKCE sí: un magic link recorre exactamente el mismo camino —
 * `/auth/v1/verify` emite un `?code=` que `exchangeCodeForSession` canjea contra
 * el verificador guardado en cookie.
 *
 * P1 — El tarro de cookies es **compartible**. Dos flujos iniciados con el mismo
 * tarro reproducen lo que hace un navegador con dos pestañas abiertas, que es
 * el escenario donde el login se rompía.
 */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const MAILPIT = 'http://127.0.0.1:54324'
const callback = () => `${appOrigin()}/auth/callback`
/** Q9 — derivada de la URL, como hace `@supabase/ssr`, no fijada a mano. */
export const CLAVE_COOKIE = `sb-${new URL(URL_).hostname.split('.')[0]}-auth-token`

export type Cookie = { name: string; value: string }
export type Tarro = Cookie[]
export type FlujoPkce = { callbackUrl: string; code: string; flowId: string | null; email: string; id: string }

export const nuevoTarro = (): Tarro => []

export const paraNavegador = (tarro: Tarro) =>
  tarro.map(c => ({ name: c.name, value: c.value, domain: appHostname(), path: '/' }))

async function esperarEnlace(email: string, plazoMs = 20_000): Promise<string> {
  const limite = Date.now() + plazoMs
  while (Date.now() < limite) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    if (r.ok) {
      const { messages } = (await r.json()) as { messages?: { ID: string }[] }
      if (messages?.length) {
        const d = await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`).then(x => x.json()) as
          { Text?: string; HTML?: string }
        const cuerpo = `${d.Text ?? ''}\n${d.HTML ?? ''}`
        const m = cuerpo.match(/https?:\/\/[^\s"'<>]*\/auth\/v1\/verify[^\s"'<>]*/)
        if (m) return m[0].replace(/&amp;/g, '&')
      }
    }
    await new Promise(r2 => setTimeout(r2, 250))
  }
  throw new Error(`no llegó el correo para ${email} en ${plazoMs} ms`)
}

/**
 * Inicia un flujo y devuelve la URL de callback lista para reproducir, con su
 * `code` y su `sb_flow_id`. Las cookies verificadoras se acumulan en `tarro`.
 */
export async function nuevoFlujoPkce(label = 'pkce', tarro: Tarro = nuevoTarro()): Promise<FlujoPkce> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`
  const creado = await admin.auth.admin.createUser({
    email, email_confirm: true, user_metadata: { full_name: `Test ${label}` } })
  if (creado.error) throw creado.error
  const id = creado.data.user!.id

  const client = createServerClient(URL_, ANON, {
    cookieOptions: { name: CLAVE_COOKIE },
    auth: { experimental: { appendPkceFlowIdToRedirects: true } },
    cookies: {
      // El tarro persiste entre llamadas: eso es lo que hace concurrentes a los
      // flujos, en vez de dos flujos aislados que nunca coexisten.
      getAll: () => tarro.map(c => ({ ...c })),
      setAll: t => {
        for (const { name, value, options } of t) {
          const i = tarro.findIndex(c => c.name === name)
          // Q9 — `maxAge: 0` es un desalojo, no un valor. Sin esto el tarro no
          // puede modelar la poda del anillo ni el teardown de la librería.
          if (options?.maxAge === 0) { if (i >= 0) tarro.splice(i, 1); continue }
          if (i >= 0) tarro[i] = { name, value }; else tarro.push({ name, value })
        }
      },
    },
  })

  const { error } = await client.auth.signInWithOtp({
    email, options: { shouldCreateUser: false, emailRedirectTo: `${callback()}?next=%2F` },
  })
  if (error) throw error

  const res = await fetch(await esperarEnlace(email), { redirect: 'manual' })
  const location = res.headers.get('location') ?? ''
  const url = new URL(location, callback())
  const code = url.searchParams.get('code')
  if (!code) throw new Error(`verify no devolvió code. Location: ${location || '(vacío)'}`)

  return { callbackUrl: url.toString(), code, flowId: url.searchParams.get('sb_flow_id'), email, id }
}
