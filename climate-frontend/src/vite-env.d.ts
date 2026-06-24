/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base origin for the Go API. Empty (same-origin `/api`) in dev (proxied) and prod (nginx). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
