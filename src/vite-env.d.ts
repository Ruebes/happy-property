/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Bau-Kennung (Datum + Uhrzeit des Builds), gesetzt in vite.config.ts. */
declare const __BUILD_ID__: string
