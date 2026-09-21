import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { safeNext } from '@/lib/routes'
import { LoginButton } from './LoginButton'

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect(safeNext(next))

  return (
    <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Super</h1>
        <p className="mt-2 text-neutral-500">La lista de la compra, compartida.</p>
      </div>
      <LoginButton next={next} />
    </main>
  )
}
