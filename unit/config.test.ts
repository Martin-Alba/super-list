import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * M4 / DoD 8 — el límite del servicio de realtime venía comentado, con su valor
 * por defecto de 4096. Una sesión OAuth real produce una cabecera `Cookie` de
 * 5.430 bytes, así que Kong rechazaba cada upgrade con 431 y el canal nunca
 * abría. Capa (§E.1): la configuración, que es donde vive el requisito.
 */

function leerMaxHeaderLength(toml: string): number | null {
  const seccion = toml.split(/^\[/m).find(s => s.startsWith('realtime]'))
  if (!seccion) return null
  const linea = seccion.split('\n').find(l => /^\s*max_header_length\s*=/.test(l))
  if (!linea) return null
  const m = linea.match(/=\s*(\d+)/)
  return m ? Number(m[1]) : null
}

describe('M4 el límite de cabecera admite una sesión OAuth real', () => {
  const toml = readFileSync('supabase/config.toml', 'utf8')

  // U7 — el límite NO debe estar subido. Con los hosts separados no hace falta,
  // y un techo 4× absorbería el 431 que debe delatar que los hosts se juntaron:
  // sería tapar la señal que la deuda promete como diagnóstico.
  it('max_header_length no está subido: el 431 debe seguir delatando la topología', () => {
    expect(leerMaxHeaderLength(toml), 'sigue subido; taparía la señal').toBeNull()
  })

  // P7 / DoD 22 — 200 eran ~50 veces lo que la suite necesita, y sería
  // amplificación de correo si esta configuración llegara a empujarse.
  it('el límite de correos no excede lo que la suite necesita', () => {
    const m = toml.match(/^email_sent = (\d+)$/m)
    expect(m, 'no se encontró email_sent').not.toBeNull()
    const valor = Number(m![1])
    expect(valor, 'excede lo que la suite necesita').toBeLessThanOrEqual(30)
    // Q12/S10 — suelo además de techo: la suite consume ~26 correos por pasada
    // (los tests PKCE del callback y de cabecera), no 9 como decía antes; y sin
    // esto añadir dos tests PKCE la deja en una pasada por hora sin aviso.
    expect(valor, 'por debajo de lo que la suite consume: se agotará a mitad de tanda')
      .toBeGreaterThanOrEqual(20)
  })

  // Sonda (§E.2): el lector tiene que saber distinguir, o el test de arriba
  // pasaría con cualquier fichero.
  it('el lector detecta un valor comentado y uno de otra sección', () => {
    expect(leerMaxHeaderLength('[realtime]\n# max_header_length = 4096\n')).toBeNull()
    expect(leerMaxHeaderLength('[studio]\nmax_header_length = 99999\n')).toBeNull()
    expect(leerMaxHeaderLength('[realtime]\nmax_header_length = 16384\n')).toBe(16384)
  })
})
