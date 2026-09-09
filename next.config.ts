import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * R1 — Detección de conectividad de primera clase. Enciende el hook
   * `useOffline()` y, de paso, el reintento automático de navegaciones y Server
   * Actions cuando la red vuelve.
   *
   * Es una bandera experimental en producción, y la decisión está tomada a
   * conciencia (D.1): lo que hay detrás está documentado y medido —sonda `HEAD`
   * al propio origen, 200 ms, espera escalonada hasta 3 s— y su peor fallo es
   * que un aviso tarde, no que se pierda un dato.
   */
  experimental: { useOffline: true },
};

export default nextConfig;
