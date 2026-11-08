import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bindingsDir = fileURLToPath(new URL('./src/module_bindings', import.meta.url));
const stub = fileURLToPath(new URL('./src/stdb/bindings-stub.ts', import.meta.url));
const hasBindings = existsSync(`${bindingsDir}/index.ts`);

/** Warn loudly when generated bindings are missing. The app then runs only in ?mock=1 preview mode. */
const bindingsNotice = (): Plugin => ({
  name: 'welfare-bindings-notice',
  configResolved() {
    if (!hasBindings) {
      console.warn(
        '\n[welfare-check] src/module_bindings not found -> using a stub. Live SpacetimeDB mode is disabled.\n' +
          '  Generate: spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path module\n'
      );
    }
  },
});

export default defineConfig({
  plugins: [react(), bindingsNotice()],
  resolve: {
    alias: { '@bindings': hasBindings ? bindingsDir : stub },
  },
  // Shared pure logic (urgency weights, haversine, seed data) lives in ../module/src.
  // host: true listens on every network interface, so phones on the laptop's hotspot can open the demo.
  server: { fs: { allow: ['..'] }, port: 5173, host: true },
});
