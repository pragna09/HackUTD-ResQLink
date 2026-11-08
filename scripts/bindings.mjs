// Generates TypeScript client bindings from /module into every client package.
// Requires the SpacetimeDB CLI (`spacetime`) on PATH.
import { execFileSync } from 'node:child_process';

const targets = ['web/src/module_bindings', 'agents/module_bindings', 'seed/module_bindings', 'apps/mobile/src/module_bindings'];
for (const out of targets) {
  console.log(`spacetime generate --lang typescript --out-dir ${out} --module-path module`);
  execFileSync('spacetime', ['generate', '--lang', 'typescript', '--out-dir', out, '--module-path', 'module'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
