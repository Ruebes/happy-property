import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

export default function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const { profile } = useAuth()
  const current = i18n.language?.startsWith('de') ? 'de' : 'en'

  const toggle = (lang: 'de' | 'en') => {
    i18n.changeLanguage(lang)
    // Eingeloggt? Wahl im Profil speichern — damit sie geräteübergreifend gilt,
    // zu den Sprach-Mails/WhatsApp passt und vom nächsten Login nicht zurück-
    // gesetzt wird (auth.fetchProfile zieht die UI-Sprache aus dem Profil).
    if (profile?.id && profile.language !== lang) {
      void supabase.from('profiles').update({ language: lang }).eq('id', profile.id)
    }
  }

  return (
    <div className="flex items-center gap-1 font-body text-sm font-medium">
      <button
        onClick={() => toggle('de')}
        className={`px-2 py-1 rounded transition-colors ${
          current === 'de'
            ? 'bg-hp-highlight text-white'
            : 'text-hp-slate hover:text-hp-highlight'
        }`}
      >
        DE
      </button>
      <span className="text-gray-300">|</span>
      <button
        onClick={() => toggle('en')}
        className={`px-2 py-1 rounded transition-colors ${
          current === 'en'
            ? 'bg-hp-highlight text-white'
            : 'text-hp-slate hover:text-hp-highlight'
        }`}
      >
        EN
      </button>
    </div>
  )
}
