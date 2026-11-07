// Used by vite.config.ts ONLY when src/module_bindings does not exist yet.
// Live mode refuses to start with this stub; the app shows how to generate the real bindings.
// Not type-checked (excluded in tsconfig) so `npm run typecheck` still reports missing bindings honestly.
export const BINDINGS_MISSING = true;
export const DbConnection = undefined;
