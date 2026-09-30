import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

interface Props {
  // 'default': Aussehen wie bisher (Login, Unterschrift, Gäste-Layout, alte
  //            Navigation), unverändert.
  // 'shell':   neue Navigation. Korall nur als dünner Strich unter der aktiven
  //            Sprache, keine Korall-Fläche.
  // 'shellTouch': wie 'shell', mit 44 px Tippfläche (Mehr-Blatt auf dem Telefon).
  tone?: 'default' | 'shell' | 'shellTouch'
}

const LANGS = ['de', 'en'] as const

export default function LanguageSwitcher({ tone = 'default' }: Props) {
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

  if (tone !== 'default') {
    const size = tone === 'shellTouch' ? 'min-h-[44px] min-w-[44px] px-2' : 'px-2 py-1'
    return (
      <div className="flex items-center gap-1 font-body text-sm">
        {LANGS.map(lang => (
          <button
            key={lang}
            type="button"
            aria-pressed={current === lang}
            onClick={() => toggle(lang)}
            className={`${size} border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 ${
              current === lang
                ? 'border-hp-highlight font-semibold text-hp-navy'
                : 'border-transparent font-medium text-gray-500 hover:text-hp-navy'
            }`}
          >
            {lang.toUpperCase()}
          </button>
        ))}
      </div>
    )
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
