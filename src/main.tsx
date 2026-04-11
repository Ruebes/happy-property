import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/i18n'
import './styles/globals.css'
import App from './App'

// ── Google OAuth Popup Guard ───────────────────────────────────────────────────
// GIS Token Client öffnet nach dem OAuth-Flow einen Popup der zurück auf
// UNSERE Domain redirectet (z.B. /#access_token=GOOGLE_TOKEN&token_type=Bearer).
// Wenn wir hier React+Supabase normal starten, sieht Supabase "detectSessionInUrl"
// den Google-Token im Hash, versucht ihn als Supabase-JWT zu verarbeiten und
// kann dabei den Supabase-Auth-State in localStorage beschädigen → SIGNED_OUT.
// FIX: Wenn dieses Fenster ein OAuth-Redirect-Popup von Google ist, React NICHT
// rendern. GIS liest den Token selbst aus dem Popup-Fenster und schließt es.
const hash = window.location.hash
const isGoogleOAuthPopup =
  window.opener !== null &&            // Fenster wurde via window.open() geöffnet
  hash.includes('access_token=') &&   // OAuth-Response im Hash
  hash.includes('token_type=Bearer') &&
  !hash.includes('type=recovery') &&   // Kein Supabase Password-Reset
  !hash.includes('type=invite')        // Kein Supabase Invite

if (!isGoogleOAuthPopup) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
