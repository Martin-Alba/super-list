import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { boundedFetch } from '@/lib/boundedFetch'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: boundedFetch() },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Server Component: la renovación la hace el middleware.
          }
        },
      },
    },
  )
}
