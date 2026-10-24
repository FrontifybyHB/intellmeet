/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Backend API base (".../api"). When unset the app calls the same-origin
   * "/api" path, which the dev server proxies to the backend.
   */
  readonly VITE_API_URL?: string;
  /** Deployed frontend origin used for canonical and sitemap URLs. */
  readonly VITE_PUBLIC_ORIGIN?: string;
  /** Dev-server proxy target (vite.config.ts only). Defaults to localhost:3000. */
  readonly VITE_PROXY_TARGET?: string;
}
