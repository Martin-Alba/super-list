import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { BotonSalir } from './BotonSalir'
import { CreateGroupForm } from './CreateGroupForm'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
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
    <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Mis grupos</h1>
        <BotonSalir usuario={user.id} />
      </header>

      <ul className="flex flex-col gap-2" data-testid="groups">
        {(groups ?? []).map(g => (
          <li key={g.id}>
            {/**
              * Spec H / i3-R1 — El nombre del grupo lo escribe la persona y la base no le mira el
              * formato: `groups.name` acepta 200 caracteres y su único `check` es que no esté en
              * blanco. Un nombre **sin un solo espacio** es una entrada legítima, y medido a 390 px
              * llevaba esta pantalla a 473: la primera que se abre al entrar, desplazándose en
              * horizontal.
              *
              * Aquí el nombre es la etiqueta entera del enlace, así que se recorta con puntos
              * suspensivos. `truncate` funciona **porque el `main` lleva `w-full`** — sin eso, su
              * `white-space: nowrap` estiraría el contenedor en vez de recortarse, que era la causa
              * raíz que cerró la iteración 2.
              */}
            <Link href={`/g/${g.id}`}
              className="block min-h-[44px] truncate rounded-xl border border-neutral-200 p-4">
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
