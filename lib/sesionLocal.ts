/**
 * K4 — ¿Queda sesión en **este dispositivo**?
 *
 * La marca de quién estaba dentro dice de quién es la instantánea guardada; no
 * dice quién está mirando la pantalla. Sin esta pregunta, borrar las cookies
 * —cerrar sesión a medias, una caducidad, otra persona que coge el móvil— dejaba
 * la lista del anterior visible con sólo navegar a la URL del grupo sin red.
 *
 * Se mira la **presencia** de la cookie, no su contenido: es local, no necesita
 * red —que es el escenario entero de esta entrega— y no vuelve a escribir el
 * adaptador de cookies propio que este proyecto ya pagó dos veces (T2).
 *
 * Fuera de alcance, escrito: quien pueda fabricar esa cookie o abrir el almacén
 * con las herramientas del navegador ya tiene el dispositivo. Esa frontera la
 * pone el sistema operativo.
 */
const COOKIE_SESION = /(?:^|;\s*)sb-[^=;\s]*-auth-token(?:\.\d+)?=[^;]/

export function haySesionLocal(
  cookies: string = typeof document === 'undefined' ? '' : document.cookie,
): boolean {
  return COOKIE_SESION.test(cookies)
}
