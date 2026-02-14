interface ImportMetaEnv {
  readonly VITE_VOLTCODE_SERVER_HOST: string
  readonly VITE_VOLTCODE_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
