/**
 * Installs the `@/` alias resolver, then nothing else.
 *
 * Loaded with `node --import ./scripts/register-hooks.mjs <script>`, because a
 * resolver hook has to be registered before the module graph it affects starts
 * loading — importing it from inside the script would be too late.
 */
import { register } from "node:module";

// `import.meta.url` is already a file:// URL; passing it through
// pathToFileURL would encode it a second time and resolve to nothing.
register("./alias-hooks.mjs", import.meta.url);
