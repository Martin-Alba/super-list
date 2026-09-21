'use client'

import { createClient } from '@/lib/supabase/client'
import { safeNext } from '@/lib/routes'

export function LoginButton({ next }: { next?: string }) {
  async function signIn() {
    const supabase = createClient()
    const target = safeNext(next)
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}` },
    })
  }
  return (
    <button
      onClick={signIn}
      data-testid="google-signin"
      className="min-h-[44px] rounded-xl bg-neutral-900 px-5 py-3 text-white"
    >
      Entrar con Google
    </button>
  )
}
