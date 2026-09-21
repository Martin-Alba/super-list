'use client'

import { useEffect, useState } from 'react'
import { useOffline } from 'next/offline'

/**
 * R1 — Dos señales independientes, porque cada una es ciega donde la otra ve.
 *
 * `useOffline()` sondea el origen de la app y **cuenta como en línea** cualquier
 * petición que siga pendiente a los 200 ms: eso es lo que le permite cazar un
 * portal cautivo, y también lo que la hace parpadear cuando la interfaz está
 * caída y las conexiones se quedan colgadas en vez de fallar rápido. Medido: con
 * la red cortada, la app volvía a creerse conectada a mitad de una prueba, y una
 * edición que debía bloquearse salía por el camino normal.
 *
 * `navigator.onLine` no tiene ese problema —el sistema operativo dice si hay
 * interfaz— pero da falso positivo con un router sin salida a internet.
 *
 * La unión de las dos cubre los dos casos, y hacia el lado seguro: ante la duda,
 * sin red. Lo que se pierde es apuntar directamente en un momento en que sí se
 * podía escribir; lo que se gana es no perder un gesto por creerse conectado.
 */
export function useSinRed(): boolean {
  const sondaDeNext = useOffline()
  const [interfazCaida, setInterfazCaida] = useState(false)

  useEffect(() => {
    const mirar = () => setInterfazCaida(!navigator.onLine)
    mirar()
    window.addEventListener('online', mirar)
    window.addEventListener('offline', mirar)
    return () => {
      window.removeEventListener('online', mirar)
      window.removeEventListener('offline', mirar)
    }
  }, [])

  return sondaDeNext || interfazCaida
}
