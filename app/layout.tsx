import type { Metadata, Viewport } from 'next'
import './globals.css'
import { RegistrarSW } from './RegistrarSW'
import { RecordarUsuario } from './RecordarUsuario'

export const metadata: Metadata = {
  title: 'Super',
  description: 'La lista de la compra, compartida.',
}

// R13 — sin esto el móvil renderiza a ancho de escritorio y escala.
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

/**
 * J1 — Quién está dentro se registra **aquí**, y en ningún otro sitio.
 *
 * Estuvo en la vista del grupo y llegaba tarde; se movió a las páginas con sesión
 * y seguía llegando tarde, porque `page.tsx` devuelve `PendingView` **antes** y la
 * página de invitación redirige sin renderizar nada. Medido con dos sesiones
 * reales: un miembro `pending` abría sin red la URL del grupo de otro y veía su
 * lista.
 *
 * El layout es el único punto por el que pasa todo lo que se rendere, así que es
 * el único sitio donde el registro no depende de qué vista gane la rama.
 *
 * K7 — Y se monta **siempre**, sin preguntarle al servidor por la sesión: quién
 * está dentro lo sabe el propio navegador, y preguntarlo aquí eran dos viajes más
 * a `/auth/v1/user` por render encima de los que ya hacen el proxy y la página.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <RegistrarSW />
        <RecordarUsuario />
        {children}
      </body>
    </html>
  )
}
