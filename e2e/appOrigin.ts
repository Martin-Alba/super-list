/**
 * V1 — Esto era una constante evaluada al **cargar** el módulo. Un test que fija
 * `E2E_BASE_URL` dentro del `it` lo hace después del import, así que la variable
 * no llegaba nunca y la aserción era inerte: `unit/global-setup.test.ts` pasaba
 * porque no había servidor en `localhost:3000`, no porque el puerto 9 estuviera
 * muerto. Con un `pnpm dev` levantado, el mismo commit daba 210/211.
 *
 * V9 — Y es la única fuente: `playwright.config.ts` deriva de aquí su `baseURL`
 * y la `url` de su `webServer`. Antes `E2E_BASE_URL` movía los tests y dejaba el
 * servidor donde estaba, que es una divergencia que no avisa.
 */
export const DEFECTO = 'http://localhost:3000'

export const appOrigin = () => process.env.E2E_BASE_URL ?? DEFECTO
export const appHostname = () => new URL(appOrigin()).hostname
/** W10 — `|| 80` devolvía 80 para cualquier `https://`, que es el caso en cuanto
 *  esto apunte a un despliegue de vista previa. */
export const appPort = () => {
  const u = new URL(appOrigin())
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80))
}

/**
 * Y8 — Estaba duplicada en `global-setup` y en `playwright.config`, y rechazaba
 * `0.0.0.0` y `[::1]`, que es como queda un `supabase start` ligado a todas las
 * interfaces: se negaba a montar el banco sin motivo. Falla cerrado ante
 * cualquier cosa que no sea inequívocamente local.
 */
export function esHostLocal(host: string): boolean {
  const limpio = host.replace(/^\[|\]$/g, '').toLowerCase()
  return limpio === 'localhost' || limpio === '0.0.0.0' || limpio === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(limpio)
}

export const esOrigenLocal = () => esHostLocal(appHostname())

/**
 * U13 / deuda 51 — La separación de hosts es lo que impide que la cookie de
 * sesión de la app viaje al endpoint de Supabase: el 431 de Kong del 2026-09-06.
 * El navegador acota las cookies por **nombre de host**, no por dirección, y por
 * eso `localhost` y `127.0.0.1` sirven aunque sean la misma interfaz de red.
 *
 * Ésa es la propiedad comprobable, y es de configuración. La guarda anterior
 * —«la app no atiende en el host de Supabase»— pedía separación a nivel de TCP
 * para proteger una propiedad de cookies: imposible, porque
 * `next start --hostname localhost` liga `127.0.0.1`. Nació roja el 2026-09-07 y
 * el registro la contó verde tres veces.
 *
 * Devuelve el host compartido, o `null` si están separados.
 */
export function hostCompartido(origenApp: string, urlSupabase: string): string | null {
  const host = (u: string) => new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const app = host(origenApp)
  return app === host(urlSupabase) ? app : null
}
