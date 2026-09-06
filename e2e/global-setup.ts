/**
 * Playwright espera a que el servidor responda, pero eso sólo prueba que el
 * proceso está vivo: el primer render todavía paga el arranque en frío
 * (conexión a Supabase, primer RSC). Sin calentarlo, el primer test de la tanda
 * compite contra ese coste y agota su espera — verde en aislamiento, rojo en
 * suite, que es la peor clase de test.
 */
export default async function globalSetup() {
  const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000'

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
}
