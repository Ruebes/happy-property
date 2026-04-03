import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:     true,                    // Session in localStorage behalten
    autoRefreshToken:   true,                    // Token automatisch erneuern (vor Ablauf)
    detectSessionInUrl: true,                    // Invite/Recovery-Token aus URL verarbeiten
    storageKey:         'happy-property-auth',   // Eindeutiger Key → kein Konflikt
    storage:            window.localStorage,     // Explizit localStorage (Workaround für Browser-Throttling)
  },
})
