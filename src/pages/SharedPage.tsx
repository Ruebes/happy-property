// Oeffentliche Freigabe-Seite: /seite/:token — zeigt eine fertig gestaltete
// HTML-Seite aus shared_pages (z. B. ein persoenliches Angebot fuer Kunden).
// Abruf ueber die security-definer-RPC hp_shared_page (anon, nur per Token,
// nur solange expires_at nicht erreicht ist); gerendert im iframe (srcDoc),
// damit die Seiten-Styles die App nicht beruehren.
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function SharedPage() {
  const { token } = useParams<{ token: string }>()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error: e } = await supabase.rpc('hp_shared_page', { p_token: token ?? '' })
        if (e) throw e
        const row = Array.isArray(data) ? data[0] : null
        if (!row) { setError(true); return }
        document.title = row.title
        setHtml(row.html as string)
      } catch (err) {
        console.error('[SharedPage] laden:', err)
        setError(true)
      }
    }
    void load()
  }, [token])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center" style={{ backgroundColor: '#fffcf6' }}>
        <p className="text-gray-500">Dieser Link ist nicht mehr verfügbar.</p>
      </div>
    )
  }
  if (html === null) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#fffcf6' }}>
        <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
      </div>
    )
  }
  return (
    <iframe
      srcDoc={html}
      title="Happy Property"
      allow="autoplay; fullscreen"
      className="w-full border-0 block"
      style={{ height: '100dvh', backgroundColor: '#fffcf6' }}
    />
  )
}
