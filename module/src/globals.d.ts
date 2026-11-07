// The SpacetimeDB JS host provides a console (logs show up in `spacetime logs`).
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
