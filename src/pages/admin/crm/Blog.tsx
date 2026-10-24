import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Blog ──────────────────────────────────────────────────────────────────────
// Prüfwarteschlange für den Blog-Autopiloten (GitHub Ruebes/hp-blog-autopilot).
// Der Autopilot hält immer 4 ungeprüfte Artikel vor. Sven liest sie hier, gibt frei
// (nächster freier Dienstag 07:00 Zypern) oder lehnt ab. Der tägliche Lauf plant freigegebene
// Artikel in WordPress ein und legt die Social-Posts an (LinkedIn, Facebook, Instagram).
// Autobetrieb (crm_settings.blog_autopilot.enabled): neue Artikel werden ohne Prüfung freigegeben.

interface Punkte { seo?: number; geo?: number; fakten?: number; stimme?: number; chef?: number }
interface Social { facebook?: string; instagram?: string; linkedin?: string; bild_url?: string }
interface BlogArtikel {
  id: string; status: string; titel: string; slug: string; anriss: string | null
  beitragsbild_url: string | null; punkte: Punkte; social: Social; geplant_fuer: string | null
  wp_link: string | null; created_at: string; abgelehnt_grund: string | null; fehler: string | null
  kosten_usd: number | null
}
interface Einstellung { enabled?: boolean; vorrat?: number }

type Reiter = 'pruefen' | 'geplant' | 'live' | 'abgelehnt'
const REITER_STATUS: Record<Reiter, string[]> = {
  pruefen: ['ungeprueft'],
  geplant: ['freigegeben', 'geplant'],
  live: ['veroeffentlicht'],
  abgelehnt: ['abgelehnt', 'fehler'],
}

const termin = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Nicosia' })
  : '–'
const datum = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

export default function Blog() {
  const { t } = useTranslation()
  const [artikel, setArtikel] = useState<BlogArtikel[]>([])
  const [loading, setLoading] = useState(true)
  const [reiter, setReiter] = useState<Reiter>('pruefen')
  const [cfg, setCfg] = useState<Einstellung>({ enabled: false, vorrat: 4 })
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [offen, setOffen] = useState<BlogArtikel | null>(null)
  const [vorschau, setVorschau] = useState<string>('')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data, error }, { data: s }] = await Promise.all([
        supabase.from('blog_artikel')
          .select('id, status, titel, slug, anriss, beitragsbild_url, punkte, social, geplant_fuer, wp_link, created_at, abgelehnt_grund, fehler, kosten_usd')
          .order('created_at', { ascending: false }).limit(200),
        supabase.from('crm_settings').select('value').eq('key', 'blog_autopilot').maybeSingle(),
      ])
      if (error) throw error
      setArtikel((data as BlogArtikel[]) ?? [])
      try { setCfg(JSON.parse((s as { value: string } | null)?.value ?? '{}') as Einstellung) } catch { setCfg({}) }
    } catch (e) { console.error('[Blog] load:', e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const oeffnen = async (a: BlogArtikel) => {
    setOffen(a); setVorschau('')
    const { data, error } = await supabase.from('blog_artikel').select('vorschau_html').eq('id', a.id).single()
    if (error) { console.error('[Blog] vorschau:', error); return }
    setVorschau((data as { vorschau_html: string | null }).vorschau_html ?? '')
  }

  const freigeben = async (a: BlogArtikel) => {
    setBusy(a.id)
    try {
      const { data, error } = await supabase.rpc('blog_freigeben', { p_id: a.id })
      if (error) throw error
      showToast(t('crm.blog.approved', 'Freigegeben. Erscheint am {{d}}.', { d: termin(data as string) }))
      setOffen(null); void load()
    } catch (e) {
      console.error('[Blog] freigeben:', e)
      showToast(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const ablehnen = async (a: BlogArtikel) => {
    const grund = window.prompt(t('crm.blog.rejectReason', 'Warum ablehnen? (optional, hilft dem Autopiloten)') as string, '')
    if (grund === null) return
    setBusy(a.id)
    try {
      const { error } = await supabase.rpc('blog_ablehnen', { p_id: a.id, p_grund: grund })
      if (error) throw error
      showToast(t('crm.blog.rejected', 'Abgelehnt. Der Autopilot schreibt einen neuen Artikel nach.'))
      setOffen(null); void load()
    } catch (e) {
      console.error('[Blog] ablehnen:', e)
      showToast(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const zuruecknehmen = async (a: BlogArtikel) => {
    setBusy(a.id)
    try {
      const { error } = await supabase.rpc('blog_zuruecknehmen', { p_id: a.id })
      if (error) throw error
      showToast(t('crm.blog.withdrawn', 'Freigabe zurückgenommen.'))
      void load()
    } catch (e) {
      console.error('[Blog] zuruecknehmen:', e)
      showToast(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const autobetrieb = async () => {
    const an = !cfg.enabled
    if (an && !window.confirm(t('crm.blog.autoConfirm', 'Autobetrieb einschalten? Neue Artikel, die alle Prüfungen bestehen, werden dann ohne dein OK eingeplant und veröffentlicht, samt Social-Posts.') as string)) return
    const neu = { ...cfg, enabled: an }
    const alt = cfg
    setCfg(neu)
    const { error } = await supabase.from('crm_settings')
      .upsert({ key: 'blog_autopilot', value: JSON.stringify(neu), updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) { console.error('[Blog] autobetrieb:', error); setCfg(alt); showToast(error.message); return }
    showToast(an ? t('crm.blog.autoOn', 'Autobetrieb ist an.') : t('crm.blog.autoOff', 'Autobetrieb ist aus. Neue Artikel warten auf deine Freigabe.'))
  }

  const zahl = (r: Reiter) => artikel.filter(a => REITER_STATUS[r].includes(a.status)).length
  const liste = artikel.filter(a => REITER_STATUS[reiter].includes(a.status))
  const ziel = cfg.vorrat ?? 4

  const PunkteChips = ({ p }: { p: Punkte }) => (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {([['chef', 'Chefredaktion'], ['fakten', 'Fakten'], ['stimme', 'Stimme'], ['seo', 'SEO'], ['geo', 'KI-Suche']] as const)
        .filter(([k]) => typeof p?.[k] === 'number')
        .map(([k, label]) => (
          <span key={k} className={`text-xs px-2 py-0.5 rounded-full ${(p[k] ?? 0) >= 85 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {label} {p[k]}
          </span>
        ))}
    </div>
  )

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-2xl text-hp-slate">{t('crm.blog.title', 'Blog')}</h1>
            <p className="text-sm text-gray-500 mt-1">
              {t('crm.blog.subtitle', 'Artikel vom Autopiloten für steuervorteil-zypern-immobilien.com prüfen und freigeben. Erscheinen dienstags 07:00 (Zypern), Social-Posts am selben Tag mit mindestens 3 Stunden Abstand zu anderen Posts.')}
            </p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm px-4 py-3 flex items-center gap-3">
            <div>
              <p className="text-sm font-semibold text-hp-slate">{t('crm.blog.auto', 'Autobetrieb')}</p>
              <p className="text-xs text-gray-500">{cfg.enabled ? t('crm.blog.autoHintOn', 'Bestandene Artikel gehen ohne Prüfung raus') : t('crm.blog.autoHintOff', 'Jeder Artikel wartet auf deine Freigabe')}</p>
            </div>
            <button type="button" role="switch" aria-checked={!!cfg.enabled} onClick={() => void autobetrieb()}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${cfg.enabled ? 'bg-orange-500' : 'bg-gray-300'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${cfg.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Kennzahlen */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-6">
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <p className="text-xs text-gray-500">{t('crm.blog.statPending', 'Zur Prüfung')}</p>
            <p className="text-2xl font-semibold text-hp-slate">{zahl('pruefen')} <span className="text-sm text-gray-400 font-normal">/ {ziel}</span></p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <p className="text-xs text-gray-500">{t('crm.blog.statPlanned', 'Eingeplant')}</p>
            <p className="text-2xl font-semibold text-hp-slate">{zahl('geplant')}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm p-4 col-span-2 sm:col-span-1">
            <p className="text-xs text-gray-500">{t('crm.blog.statLive', 'Veröffentlicht')}</p>
            <p className="text-2xl font-semibold text-hp-slate">{zahl('live')}</p>
          </div>
        </div>

        {/* Reiter */}
        <div className="flex gap-1 mt-6 border-b border-gray-200 overflow-x-auto">
          {([['pruefen', t('crm.blog.tabPending', 'Zur Prüfung')], ['geplant', t('crm.blog.tabPlanned', 'Eingeplant')],
            ['live', t('crm.blog.tabLive', 'Veröffentlicht')], ['abgelehnt', t('crm.blog.tabRejected', 'Abgelehnt')]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setReiter(k)}
              className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${reiter === k ? 'border-hp-highlight text-hp-slate font-medium' : 'border-transparent text-gray-500 hover:text-hp-slate'}`}>
              {label} <span className="text-gray-400">({zahl(k)})</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-orange-300 border-t-hp-highlight rounded-full animate-spin" />
          </div>
        ) : liste.length === 0 ? (
          <p className="text-center text-gray-400 py-10">
            {reiter === 'pruefen' ? t('crm.blog.emptyPending', 'Gerade nichts zu prüfen. Der Autopilot schreibt täglich nach, bis wieder 4 Artikel bereitliegen.') : t('crm.blog.empty', 'Noch keine Artikel.')}
          </p>
        ) : (
          <div className="space-y-3 mt-4">
            {liste.map(a => (
              <div key={a.id} className="bg-white rounded-2xl shadow-sm p-4 flex flex-col sm:flex-row gap-4">
                {a.beitragsbild_url && (
                  <button onClick={() => void oeffnen(a)} className="shrink-0">
                    <img src={a.beitragsbild_url} alt="" className="w-full sm:w-44 rounded-xl object-cover aspect-[774/541]" />
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <button onClick={() => void oeffnen(a)} className="text-left font-medium text-hp-slate hover:text-hp-highlight">{a.titel}</button>
                  {a.anriss && <p className="text-sm text-gray-600 mt-1 line-clamp-2">{a.anriss}</p>}
                  <PunkteChips p={a.punkte} />
                  <p className="text-xs text-gray-400 mt-2">
                    {t('crm.blog.created', 'Geschrieben am {{d}}', { d: datum(a.created_at) })}
                    {a.geplant_fuer && ` · ${t('crm.blog.date', 'Termin')}: ${termin(a.geplant_fuer)}`}
                    {a.abgelehnt_grund && ` · ${t('crm.blog.reason', 'Grund')}: ${a.abgelehnt_grund}`}
                    {a.fehler && ` · ${t('crm.blog.error', 'Fehler')}: ${a.fehler}`}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button onClick={() => void oeffnen(a)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
                      {t('crm.blog.read', 'Lesen')}
                    </button>
                    {a.status === 'ungeprueft' && (
                      <>
                        <button disabled={busy === a.id} onClick={() => void freigeben(a)} className="text-xs px-3 py-1.5 rounded-lg font-medium text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                          {t('crm.blog.approve', 'Freigeben')}
                        </button>
                        <button disabled={busy === a.id} onClick={() => void ablehnen(a)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                          {t('crm.blog.reject', 'Ablehnen')}
                        </button>
                      </>
                    )}
                    {a.status === 'freigegeben' && (
                      <button disabled={busy === a.id} onClick={() => void zuruecknehmen(a)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                        {t('crm.blog.withdraw', 'Freigabe zurücknehmen')}
                      </button>
                    )}
                    {a.wp_link && a.status === 'veroeffentlicht' && (
                      <a href={a.wp_link} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
                        {t('crm.blog.view', 'Auf der Website ansehen')}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lesen */}
      {offen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6" onClick={() => setOffen(null)}>
          <div className="bg-white w-full max-w-4xl sm:rounded-2xl shadow-xl flex flex-col max-h-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
              <p className="font-medium text-hp-slate flex-1 truncate">{offen.titel}</p>
              {offen.status === 'ungeprueft' && (
                <>
                  <button disabled={busy === offen.id} onClick={() => void freigeben(offen)} className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                    {t('crm.blog.approve', 'Freigeben')}
                  </button>
                  <button disabled={busy === offen.id} onClick={() => void ablehnen(offen)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600">
                    {t('crm.blog.reject', 'Ablehnen')}
                  </button>
                </>
              )}
              <button onClick={() => setOffen(null)} className="text-gray-400 hover:text-gray-700 px-2 text-lg" aria-label="Schließen">✕</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {vorschau
                ? <iframe title="Vorschau" srcDoc={vorschau} sandbox="" className="w-full h-[70vh] border-0" />
                : <div className="flex justify-center py-10"><div className="w-8 h-8 border-4 border-orange-300 border-t-hp-highlight rounded-full animate-spin" /></div>}
              <div className="p-4 border-t border-gray-100 space-y-3">
                <p className="text-sm font-semibold text-hp-slate">{t('crm.blog.socialTitle', 'Social-Posts am Erscheinungstag')}</p>
                {offen.social?.bild_url && <img src={offen.social.bild_url} alt="" className="w-40 rounded-lg" />}
                {([['linkedin', 'LinkedIn · 08:30'], ['facebook', 'Facebook · 12:30'], ['instagram', 'Instagram · 12:30']] as const).map(([k, label]) => (
                  offen.social?.[k] ? (
                    <div key={k}>
                      <p className="text-xs font-medium text-gray-400">{label}</p>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{offen.social[k]}</p>
                    </div>
                  ) : null
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-6 right-6 z-50 bg-hp-slate text-white text-sm px-4 py-3 rounded-xl shadow-lg max-w-sm">{toast}</div>}
    </DashboardLayout>
  )
}
