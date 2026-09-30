import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  children: ReactNode
  // Bezeichnung für das Fehlerprotokoll (console.error)
  scope?: string
  // Ersatzanzeige im Fehlerfall. Ohne Angabe erscheint der Hinweis mit
  // "Neu laden". null blendet den fehlerhaften Teil einfach aus.
  fallback?: ReactNode
}

interface State {
  failed: boolean
}

// Hinweis im Inhaltsbereich: Die Navigation bleibt stehen, nur die Seite fällt aus.
function ContentErrorMessage() {
  const { t } = useTranslation()
  return (
    <div role="alert" className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-md rounded-2xl border border-gray-100 border-t-[3px] border-t-hp-highlight bg-white p-6 text-center shadow-sm">
        <h2 className="font-heading text-xl text-hp-navy">{t('shell.error.title')}</h2>
        <p className="mt-2 text-sm font-body text-gray-600">{t('shell.error.body')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 inline-flex items-center justify-center rounded-lg border border-hp-navy px-4 py-2 text-sm font-medium font-body text-hp-navy transition-colors hover:bg-hp-navy hover:text-hp-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
        >
          {t('shell.error.reload')}
        </button>
      </div>
    </div>
  )
}

// Fängt Render-Fehler im umschlossenen Teil ab, damit nicht die ganze App weiß
// wird. Die AppShell setzt die Grenze mit key={pathname} um den Seiteninhalt:
// Ein Seitenwechsel setzt sie zurück, ein Klick im Menü führt also wieder heraus.
// Fehler in Klick-Handlern und in asynchronem Code landen hier nicht (React
// fängt nur Fehler beim Rendern ab).
export default class ContentErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[shell] Fehler in ${this.props.scope ?? 'Seiteninhalt'}:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return this.props.fallback !== undefined ? this.props.fallback : <ContentErrorMessage />
  }
}
