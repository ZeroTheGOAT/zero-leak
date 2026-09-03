import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // tauri.conf.json's devUrl is pinned to 5173. Without strictPort, vite
  // silently drifts to 5174+ when a stale server holds 5173 and the window
  // loads a dead URL — a blank window with no error.
  server: {
    port: 5173,
    strictPort: true,
  },
})
