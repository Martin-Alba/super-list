import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Instrumentos del método, no producto. **Sólo `.claude/fathom/`**, que es lo que
    // `.gitignore:48` ignora de verdad: `.claude/` entero es commiteable, y excluirlo
    // sacaba de la puerta de lint fuente que sí entra al repositorio. Medido: eslint
    // analizaba esta carpeta y una sonda de medición ponía roja la puerta — que es
    // justo lo que la carpeta ignorada debía evitar.
    ".claude/fathom/**",
  ]),
]);

export default eslintConfig;
