import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requestJoinAction } from '@/app/actions'

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: preview } = await supabase.rpc('invite_preview', { p_token: token })

  // Borde 1 y 9: caducado, revocado, inexistente y malformado dicen lo mismo.
  if (!preview?.valid) {
    return (
      <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-semibold" data-testid="invite-invalid">Este link ya no sirve</h1>
        <p className="text-neutral-500">Puede haber caducado o haber sido reemplazado por uno nuevo.</p>
      </main>
    )
  }

  // R2 — la página es pública para que el invitado vea de qué grupo se trata,
  // pero unirse exige sesión; el token se conserva en el destino.
  if (!user) {
    return (
      <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-semibold">Te invitan a un grupo</h1>
        <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
          data-testid="invite-login" className="min-h-[44px] rounded-xl bg-neutral-900 px-5 py-3 text-white">
          Entrar para pedir acceso
        </Link>
      </main>
    )
  }

  const result = await requestJoinAction(token)
  if (result.status === 'invalid') redirect('/')
  redirect(`/g/${result.group_id}`)
}
