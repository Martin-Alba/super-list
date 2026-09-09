import type { MetadataRoute } from 'next'

/**
 * R8 — Instalable en la pantalla de inicio. En un supermercado, con una mano y el
 * carro en la otra, abrir desde el icono a pantalla completa es la diferencia
 * entre usarla y no; y sin manifiesto el navegador ni siquiera ofrece instalarla.
 *
 * `display: standalone` quita la barra del navegador. Los dos tamaños son los que
 * los navegadores exigen para considerarla instalable: 192 para el icono y 512
 * para la pantalla de arranque.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Super — lista de la compra',
    short_name: 'Super',
    description: 'La lista de la compra de tu grupo, en vivo.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f0fdfa',
    theme_color: '#0f766e',
    lang: 'es',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
