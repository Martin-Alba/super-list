import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { signOutAction } from './actions'
import { CreateGroupForm } from './CreateGroupForm'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
        <h1 className="text-3xl font-semibold">Super</h1>
        <p className="text-neutral-500">La lista de la compra, compartida.</p>
        <Link href="/login" className="min-h-[44px] rounded-xl bg-neutral-900 px-5 py-3 text-center text-white">
          Entrar
        </Link>
      </main>
    )
  }

  const { data: groups } = await supabase.from('groups').select('id, name').order('created_at')

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Mis grupos</h1>
        <form action={signOutAction}>
          <button className="min-h-[44px] px-3 text-sm text-neutral-500" data-testid="signout">Salir</button>
        </form>
      </header>

      <ul className="flex flex-col gap-2" data-testid="groups">
        {(groups ?? []).map(g => (
          <li key={g.id}>
            <Link href={`/g/${g.id}`} className="block min-h-[44px] rounded-xl border border-neutral-200 p-4">
              {g.name}
            </Link>
          </li>
        ))}
        {(groups ?? []).length === 0 && <li className="text-neutral-500">Todavía no tienes ningún grupo.</li>}
      </ul>

      <CreateGroupForm />
    </main>
  )
}
