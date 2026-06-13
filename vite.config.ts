import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// host:true so the dev server is reachable from the preview proxy / a phone on the LAN.
export default defineConfig({
  plugins: [react()],
  server: { host: true },
  build: { outDir: 'dist' },
})
