/**
 * W5 — Vivía dentro de `e2e/callback.spec.ts` y ningún test lo ejercitaba.
 * Devolvía `null` —o sea "no salta de sitio"— para `/\\evil.com/login`, que es
 * la segunda forma protocol-relative: `safeNext` nombra las dos
 * (`lib/routes.ts`), este helper miraba una.
 *
 * Importa porque los seis tests parametrizados por `Host` sólo afirman `null` y
 * `toContain('/login')`: un destino de esa forma pasaba ambas.
 */
export function hostDelDestino(location: string | null): string | null {
  if (!location) return null
  const barras = /^\/[/\\]/
  if (barras.test(location)) {
    return location.slice(2).split(/[/\\?#]/)[0] || 'protocol-relative'
  }
  if (location.startsWith('/')) return null
  try { return new URL(location).host } catch { return 'ilegible' }
}
