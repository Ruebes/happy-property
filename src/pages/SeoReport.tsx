// Oeffentliche Report-Seite: /seo-report/:token — zeigt den woechentlichen
// SEO-Bericht (seo_reports, erzeugt von seo-insights).
// Abruf ueber die security-definer-RPC hp_seo_report_html (anon, nur per Token);
// gerendert im iframe (srcDoc), damit die Report-Styles die App nicht beruehren.
// Hintergrund: die Supabase-Functions-Domain liefert text/html als text/plain
// aus, ein Direktlink dorthin zeigt also Quelltext — deshalb rendert das CRM.
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function SeoReport() {
  const { token } = useParams<{ token: string }>()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error: e } = await supabase.rpc('hp_seo_report_html', { p_token: token ?? '' })
        if (e) throw e
        if (!data) { setError(true); return }
        setHtml(data as string)
      } catch (err) {
        console.error('[SeoReport] laden:', err)
        setError(true)
      }
    }
    void load()
  }, [token])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#fffcf6' }}>
        <p className="text-gray-500">Report nicht gefunden.</p>
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
      title="SEO-Wochenbericht"
      className="w-full border-0"
      style={{ height: '100vh', backgroundColor: '#fffcf6' }}
    />
  )
}
