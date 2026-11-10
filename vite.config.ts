import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const serverPort = env.PORT || '1234'
  const backend = `http://localhost:${serverPort}`
  const wsBackend = `ws://localhost:${serverPort}`

  return {
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
        },
        '/ws': {
          target: wsBackend,
          ws: true,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  }
})
