import { useTranslation } from 'react-i18next'

export default function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const current = i18n.language?.startsWith('de') ? 'de' : 'en'

  const toggle = (lang: 'de' | 'en') => {
    i18n.changeLanguage(lang)
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
