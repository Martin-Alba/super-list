'use client'

import { useEffect } from 'react'

/**
 * R9 — Registra el service worker. Va en el layout porque el arranque en frío sin
 * red puede ocurrir en cualquier página, no sólo en la lista de un grupo.
 *
 * Fuera de producción no se registra: en desarrollo un service worker sirve
 * copias viejas del bundle y convierte cada cambio en una cacería. Es la misma
 * cicatriz que S5 dejó escrita sobre medir contra un `.next` ya borrado.
 */
export function RegistrarSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return
    void navigator.serviceWorker.register('/sw.js')
  }, [])
  return null
}
