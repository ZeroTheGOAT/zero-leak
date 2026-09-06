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
  build: {
    // Vendor split: React + Tauri API change rarely, app code changes often.
    // Separate chunks keep the main bundle under the warning limit and let the
    // desktop webview cache the vendor chunk across app updates.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'vendor-react', test: /node_modules\/(react|react-dom|scheduler)/ },
            { name: 'vendor-ui', test: /node_modules\/(lucide-react|clsx|tailwind-merge)/ },
            { name: 'vendor-tauri', test: /node_modules\/@tauri-apps/ },
          ],
        },
      },
    },
  },
})
