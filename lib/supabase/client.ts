import { createBrowserClient } from '@supabase/ssr'
import { boundedFetch } from '@/lib/boundedFetch'

/**
 * T2 — Aquí hubo un adaptador de cookies escrito a mano, para acotar la vida de
 * los verificadores PKCE. Se retira entero.
 *
 * La spec base ya lo había declarado: *"un adaptador propio sobre el
 * almacenamiento de sesión es justo donde un error se paga caro"*. Se escribió
 * igualmente, y produjo dos defectos de producción —un 500 que quemaba el código
 * de sesión al partir pares suplentes, y un lector que se atragantaba con un `%`
 * suelto en una cookie ajena— para contener un problema que **sólo existía en
 * local**, por compartir host con Supabase. Con los hosts separados (T1) esas
 * cookies ya no viajan al endpoint que las rechazaba.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // El latido por defecto tarda demasiado en delatar un socket muerto. En
      // un supermercado con mala cobertura, ese silencio es justo cuando la
      // lista deja de estar viva sin que nadie se entere (I6).
      realtime: { heartbeatIntervalMs: 8_000, timeout: 8_000 },
      global: { fetch: boundedFetch() },
      // P1 — sin esto no viaja ningún identificador de flujo en el callback, y
      // `retrievePKCEVerifier` cae a la clave fija heredada, que espeja el flujo
      // iniciado más recientemente. Medido: con dos pestañas, la que vuelve
      // primero se queda sin sesión y con su código quemado.
      auth: { experimental: { appendPkceFlowIdToRedirects: true } },
    },
  )
}
