/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google OAuth client baked in at build time (from the untracked `.env`). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}
