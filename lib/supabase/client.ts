import { createBrowserClient } from '@supabase/ssr'
import { boundedFetch } from '@/lib/boundedFetch'

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
    },
  )
}
