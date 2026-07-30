// Compile-time constants injected by `define` in vite.config.ts. Absent in plain Node (tests), so
// every read must sit behind a `typeof __APP_VERSION__ !== "undefined"` guard.
declare const __APP_VERSION__: string;
