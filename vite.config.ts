import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.jpg', 'favicon.svg'],
      manifest: {
        name: 'Happy Property',
        short_name: 'Happy Property',
        description: 'Ihr Immobilienportal',
        theme_color: '#ff795d',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/logo.jpg',
            sizes: '192x192',
            type: 'image/jpeg',
          },
          {
            src: '/logo.jpg',
            sizes: '512x512',
            type: 'image/jpeg',
          },
          {
            src: '/logo.jpg',
            sizes: '512x512',
            type: 'image/jpeg',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Nur statische App-Shell cachen (JS, CSS, HTML, Bilder)
        // Supabase-Requests NICHT cachen – Auth-Tokens, Realtime und RLS-Abfragen
        // dürfen niemals aus dem Cache kommen (würde Login-Loops und veraltete
        // Daten verursachen).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,woff2}'],
        // Supabase explizit ausschließen
        navigateFallbackDenylist: [/^\/auth\//],
        runtimeCaching: [
          {
            // Google Fonts: Cache first (ändert sich nie)
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 Jahr
              },
            },
          },
        ],
      },
    }),
  ],
})
