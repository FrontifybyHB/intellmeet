/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Backend API base (".../api"). When unset the app calls the same-origin
   * "/api" path, which the dev server proxies to the backend.
   */
  readonly VITE_API_URL?: string;
  /** Dev-server proxy target (vite.config.ts only). Defaults to localhost:5000. */
  readonly VITE_PROXY_TARGET?: string;
}
