import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Bau-Kennung: steht sichtbar im Profil-Menue. Zeigt sie ein altes Datum, laeuft
// im Browser noch ein alter Stand aus dem Service-Worker-Cache — dann hilft nur
// Tab schliessen und neu oeffnen. Vorher war das nur zu erraten.
const BUILD_ID = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.jpg', 'favicon.png', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png'],
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
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
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
        // Supabase explizit ausschließen — und ALLE öffentlichen Kunden-/Token-
        // Seiten: die dürfen nie aus dem Service-Worker-Cache kommen, sonst
        // sehen Kunden nach einem Deploy die alte Version, bis der SW irgendwann
        // aktualisiert (Sven 27.8.: Bewertungs-Fragebogen zeigte alten Stand).
        navigateFallbackDenylist: [
          /^\/auth\//,
          /^\/(bewertung|deck|rechnung|re|strategie|akte|partner|termin|sign|buchen|zusage|abmelden|anmelden|report|seo-report)(\/|$)/,
          /^\/(t|s)\//,
        ],
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
