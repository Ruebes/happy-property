import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface PropertyCard {
  id:              string
  project_name:    string
  unit_number:     string | null
  type:            'villa' | 'apartment' | 'studio'
  city:            string | null
  images:          string[]
  rental_type:     'longterm' | 'shortterm'
  property_status: 'under_construction' | 'active' | null
}

interface OwnerDocItem { id: string; title: string; kind: string; file_url: string; created_at: string }
interface OwnerNotif { id: string; title: string; body: string; created_at: string }

// ── Bug melden: Text + Screenshots → Aufgabe bei Sven ─────────────────────────
function BugModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [uploadWarn, setUploadWarn] = useState('')
  // Bereits erfolgreich hochgeladene Bilder je Datei-Index merken: ein zweiter
  // Sende-Versuch lädt sonst alles erneut hoch (Waisen im Storage).
  const uploadedRef = useRef<Record<number, { name: string; url: string; path: string }>>({})
  const send = async () => {
    if (!text.trim() || busy) { if (!text.trim()) setErr(t('eigentuemer.bug.needText', 'Bitte beschreibe kurz das Problem.')); return }
    setBusy(true); setErr('')
    try {
      const atts: Array<{ name: string; url: string; path: string }> = []
      let failedUploads = 0
      for (let i = 0; i < Math.min(files.length, 5); i++) {
        const already = uploadedRef.current[i]
        if (already) { atts.push(already); continue }
        const f = files[i]
        let blob: Blob = f
        try {
          const bmp = await createImageBitmap(f)
          const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale)
          c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
          blob = (await new Promise<Blob | null>(res => c.toBlob(res, 'image/jpeg', 0.82))) ?? f
        } catch { /* Original nehmen */ }
        const path = `bug/${profile?.id ?? 'x'}/${Date.now()}-${i}.jpg`
        const contentType = blob === f ? (f.type || 'application/octet-stream') : 'image/jpeg'
        const { error } = await supabase.storage.from('task-attachments').upload(path, blob, { contentType })
        if (error) {
          console.error('[Eigentuemer/Dashboard] bug upload:', error)
          failedUploads++
        } else {
          const att = { name: f.name, url: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/task-attachments/${path}`, path }
          uploadedRef.current[i] = att
          atts.push(att)
        }
      }
      if (failedUploads > 0 && !uploadWarn) {
        setUploadWarn(t('eigentuemer.bug.uploadFailed', '{{n}} Bild(er) konnten nicht hochgeladen werden. Du kannst die Meldung trotzdem ohne diese Bilder senden.', { n: failedUploads }))
        setBusy(false)
        return
      }
      const { data, error } = await supabase.functions.invoke('owner-content', { body: { action: 'bug_report', text: text.trim(), attachments: atts } })
      const d = (data ?? {}) as { success?: boolean; error?: string }
      if (error || d.error || !d.success) throw new Error(d.error || error?.message || 'Fehler')
      onDone(t('eigentuemer.bug.sent', 'Danke! Deine Meldung ist bei Sven gelandet — du bekommst Bescheid, sobald sie erledigt ist. 🐾'))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fehler'); setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <p className="font-semibold text-hp-black">🐞 {t('eigentuemer.bug.title', 'Problem melden')}</p>
        <p className="text-xs text-gray-500">{t('eigentuemer.bug.hint', 'Was funktioniert nicht? Screenshots helfen uns sehr.')}</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
          placeholder={t('eigentuemer.bug.ph', 'Beschreibe kurz, was passiert ist …')} />
        <input type="file" accept="image/*" multiple onChange={e => { setFiles(Array.from(e.target.files ?? [])); setUploadWarn(''); uploadedRef.current = {} }}
          className="text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 file:cursor-pointer" />
        {files.length > 0 && <p className="text-[11px] text-gray-400">📎 {files.length} {t('eigentuemer.bug.files', 'Bild(er) ausgewählt')}</p>}
        {uploadWarn && <p className="text-sm text-amber-600">⚠️ {uploadWarn}</p>}
        {err && <p className="text-sm text-red-600">❌ {err}</p>}
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-gray-600">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={() => void send()} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
            {busy ? t('eigentuemer.bug.sending', 'Sendet…') : t('eigentuemer.bug.send', 'Melden')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────
const TYPE_ICON: Record<string, string> = { villa: '🏡', apartment: '🏢', studio: '🛋️' }

export default function EigentuemerDashboard() {
  const { t, i18n } = useTranslation()
  const { profile } = useAuth()

  const [properties,    setProperties]    = useState<PropertyCard[]>([])
  const [bookingCount,  setBookingCount]  = useState<number | null>(null)
  const [docCount,      setDocCount]      = useState<number | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [loadError,     setLoadError]     = useState(false)
  const [crmImages,     setCrmImages]     = useState<Record<string, string>>({}) // property_id → first CRM project image
  const [ownerDocs,     setOwnerDocs]     = useState<OwnerDocItem[]>([])
  const [notifs,        setNotifs]        = useState<OwnerNotif[]>([])
  const [newsError,     setNewsError]     = useState(false)
  const [showBug,       setShowBug]       = useState(false)
  const [bugToast,      setBugToast]      = useState('')

  // ── Fetch ──────────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false
    // Sicherheits-Timeout: Spinner nie ewig hängen lassen (Safari/Query-Timing).
    // Wenn er zuschlägt, war die Query noch unterwegs → Fehlerzustand statt
    // fälschlich "Du hast noch keine Objekte" anzeigen.
    const safety = setTimeout(() => {
      if (cancelled) return
      setLoading(prev => { if (prev) setLoadError(true); return false })
    }, 12_000)

    async function load() {
      setLoading(true)
      setLoadError(false)
      try {
        // 1. Eigene Immobilien laden
        const { data: props, error } = await supabase
          .from('properties')
          .select('id, project_name, unit_number, type, city, images, rental_type, property_status')
          .eq('owner_id', profile!.id)
          .order('project_name')
        if (error) throw error

        if (cancelled) return
        const propList = (props ?? []) as PropertyCard[]

        if (propList.length === 0) {
          setProperties([])
          setBookingCount(0)
          setDocCount(0)
          return
        }

        const propIds = propList.map(p => p.id)

        // Objekte sind da → sofort anzeigen. Alles Weitere (Anreicherung, Zähler)
        // ist Best-Effort: Fehler dort loggen, aber NIE die schon geladenen
        // Objekte durch einen Fehler-Screen ersetzen (Muster wie Properties.tsx).
        setProperties(propList)
        setLoading(false)

        // 2a. Kanonische Unit-Daten (Projektname/Ort/Bild) aus der ZENTRALEN Tabelle
        // crm_project_units ziehen — nie die (evtl. leere/veraltete) properties-Kopie
        // anzeigen. Fixt u.a. den leeren Projektnamen („· 102" ohne Name).
        const { data: unitData, error: unitErr } = await supabase
          .from('crm_project_units')
          .select('property_id, project:crm_projects(name, images, location)')
          .in('property_id', propIds)
        if (unitErr) console.error('[Eigentuemer/Dashboard] units:', unitErr)
        if (!cancelled && unitData) {
          const metaMap: Record<string, { name?: string; city?: string; img?: string }> = {}
          for (const u of unitData) {
            const pid = (u as { property_id?: string | null }).property_id
            if (!pid) continue
            const proj = (u as { project?: { name?: string; images?: string[]; location?: string } | null }).project
            const loc = proj?.location
            metaMap[pid] = {
              name: proj?.name || undefined,
              city: (typeof loc === 'string' && !loc.startsWith('http')) ? loc : undefined,
              img:  proj?.images?.[0],
            }
          }
          const enriched = propList.map(p => ({
            ...p,
            project_name: metaMap[p.id]?.name || p.project_name,
            city:         p.city || metaMap[p.id]?.city || null,
          }))
          setProperties(enriched)
          const imgMap: Record<string, string> = {}
          for (const p of enriched) if (!p.images?.length && metaMap[p.id]?.img) imgMap[p.id] = metaMap[p.id]!.img!
          setCrmImages(imgMap)
        }

        // 2b. Buchungen + Dokumente parallel zählen (Best-Effort; stornierte
        // Buchungen zählen nicht mit). Der Dokumente-Zähler zählt NUR die
        // documents-Tabelle — genau das, was die verlinkte Seite /dokumente zeigt.
        const [bookRes, docRes] = await Promise.all([
          supabase
            .from('bookings')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds)
            .neq('status', 'cancelled'),
          supabase
            .from('documents')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds),
        ])
        if (bookRes.error) console.error('[Eigentuemer/Dashboard] bookings count:', bookRes.error)
        if (docRes.error) console.error('[Eigentuemer/Dashboard] docs count:', docRes.error)

        if (cancelled) return
        setBookingCount(bookRes.count ?? 0)
        setDocCount(docRes.count ?? 0)
      } catch (err) {
        console.error('[Eigentuemer/Dashboard] load:', err)
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true; clearTimeout(safety) }
  }, [profile?.id])

  // Neuigkeiten & Meldungen (RLS filtert: allgemein + eigene Wohnungen)
  useEffect(() => {
    if (!profile?.id) return
    void supabase.from('owner_documents').select('id, title, kind, file_url, created_at')
      .order('created_at', { ascending: false }).limit(20)
      .then(({ data, error }) => {
        if (error) { console.error('[Eigentuemer/Dashboard] owner_documents:', error); setNewsError(true); return }
        setOwnerDocs((data as OwnerDocItem[]) ?? [])
      })
    void supabase.from('owner_notifications').select('id, title, body, created_at')
      .is('read_at', null).order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) { console.error('[Eigentuemer/Dashboard] owner_notifications:', error); setNewsError(true); return }
        setNotifs((data as OwnerNotif[]) ?? [])
      })
  }, [profile?.id])
  const dismissNotif = async (id: string) => {
    // .select() erzwingen: von RLS geblocktes Update liefert 0 Zeilen OHNE Fehler —
    // die Meldung käme sonst beim nächsten Laden unsterblich wieder.
    const { data: upd, error } = await supabase.from('owner_notifications')
      .update({ read_at: new Date().toISOString() }).eq('id', id).select('id')
    if (error || !upd?.length) {
      console.error('[Eigentuemer/Dashboard] dismissNotif:', error ?? 'keine Zeile aktualisiert')
      return
    }
    setNotifs(n => n.filter(x => x.id !== id))
  }

  // ── Stat Cards ─────────────────────────────────────────────
  const statCards = [
    {
      key:   'myProperties',
      icon:  '🏠',
      value: loading ? null : properties.length,
      href:  '/eigentuemer/properties',
      clickable: true,
    },
    {
      key:       'bookings',
      icon:      '📅',
      value:     loading ? null : bookingCount,
      href:      '/kalender',
      clickable: true,
    },
    {
      key:       'documents',
      icon:      '📄',
      value:     loading ? null : docCount,
      href:      '/dokumente',
      clickable: true,
    },
    {
      key:        'avgReturn',
      icon:       '📈',
      value:      null,
      comingSoon: true,
      href:       null,
      clickable:  false,
    },
  ]

  return (
    <DashboardLayout basePath="/eigentuemer/dashboard">

      {/* ── Begrüßung ─────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-hp-black"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0] || t('roles.eigentuemer')} 👋
        </h1>
        <p className="mt-1 text-sm text-gray-500 font-body">
          {t('dashboard.eigentuemer.subtitle')}
        </p>
      </div>

      {/* ── Portal-Meldungen (z.B. „deine Bug-Meldung ist erledigt") ── */}
      {notifs.map(n => (
        <div key={n.id} className="mb-4 bg-green-50 border border-green-200 rounded-2xl p-4 flex items-start gap-3">
          <span className="text-xl">🔔</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-green-900">{n.title}</p>
            <p className="text-sm text-green-800 mt-0.5">{n.body}</p>
          </div>
          <button onClick={() => void dismissNotif(n.id)} className="text-green-700/60 hover:text-green-900 shrink-0">✕</button>
        </div>
      ))}

      {/* ── Stat-Karten ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statCards.map(({ key, icon, value, comingSoon, href, clickable }) => {
          const inner = (
            <div className={`bg-white rounded-2xl border border-gray-100 p-5 shadow-sm h-full
              ${clickable ? 'hover:border-hp-highlight hover:shadow-md transition-all cursor-pointer' : ''}`}>
              <div className="text-2xl mb-2">{icon}</div>
              {comingSoon ? (
                <>
                  <div className="text-sm font-semibold font-body text-gray-400">
                    {t('dashboard.eigentuemer.returnComingSoon')}
                  </div>
                  <div className="text-xs text-gray-400 font-body mt-0.5">
                    {t('stats.' + key)}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold font-body text-hp-black">
                    {loading ? (
                      <span className="inline-block w-8 h-6 bg-gray-100 rounded animate-pulse" />
                    ) : (value ?? 0)}
                  </div>
                  <div className="text-xs text-gray-500 font-body mt-0.5">
                    {t('stats.' + key)}
                  </div>
                </>
              )}
            </div>
          )
          return clickable && href ? (
            <Link key={key} to={href} className="block">{inner}</Link>
          ) : (
            <div key={key}>{inner}</div>
          )
        })}
      </div>

      {/* ── Meine Immobilien ──────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-50">
          <h2 className="font-semibold text-hp-black font-body text-base">
            {t('dashboard.eigentuemer.allPropertiesTitle')}
          </h2>
          {properties.length > 0 && (
            <Link
              to="/eigentuemer/properties"
              className="text-xs font-medium font-body transition-colors"
              style={{ color: 'var(--color-highlight)' }}>
              {t('dashboard.eigentuemer.viewAll')} →
            </Link>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 justify-center py-16 text-gray-400 font-body text-sm">
            <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : loadError ? (
          <div className="text-center py-16 px-6">
            <div className="text-5xl mb-4">⚠️</div>
            <p className="text-sm font-semibold text-gray-600 font-body">
              {t('eigentuemer.loadError', 'Deine Objekte konnten gerade nicht geladen werden.')}
            </p>
            <button onClick={() => window.location.reload()}
              className="mt-4 px-5 py-2 rounded-full text-white text-sm font-semibold"
              style={{ backgroundColor: 'var(--color-highlight)' }}>
              {t('common.retry', 'Neu laden')}
            </button>
          </div>
        ) : properties.length === 0 ? (
          <div className="text-center py-16 px-6">
            <div className="text-5xl mb-4">🏠</div>
            <p className="text-sm font-semibold text-gray-500 font-body">
              {t('dashboard.eigentuemer.noProperties')}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5">
              {properties.slice(0, 4).map(p => {
                const imgSrc = p.images?.[0] ?? crmImages[p.id] ?? null
                return (
                  <Link
                    key={p.id}
                    to={`/eigentuemer/properties/${p.id}`}
                    className="group rounded-2xl border border-gray-100 overflow-hidden
                               hover:border-hp-highlight hover:shadow-md transition-all">
                    {/* Bild */}
                    <div className="relative h-44 bg-gray-100 overflow-hidden">
                      {imgSrc ? (
                        <img src={imgSrc} alt={p.project_name}
                             className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-5xl text-gray-300">{TYPE_ICON[p.type] ?? '🏠'}</span>
                        </div>
                      )}
                      {/* Status-Badge oben links — bei unbekanntem Status (NULL) KEIN
                          Badge, statt fälschlich "Im Bau" zu behaupten */}
                      {p.property_status === 'active' ? (
                        <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5
                                         rounded-full bg-green-500 text-white shadow-sm flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-white inline-block" />
                          {t('eigentuemer.status.active', 'Aktiv')}
                        </span>
                      ) : p.property_status === 'under_construction' ? (
                        <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5
                                         rounded-full bg-amber-500 text-white shadow-sm">
                          🏗 {t('eigentuemer.status.construction', 'Im Bau')}
                        </span>
                      ) : null}
                      {/* Miettyp-Badge oben rechts — nur bei gesetztem Typ */}
                      {p.rental_type && (
                        <span className="absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5
                                         rounded-full bg-white/90 backdrop-blur-sm text-gray-600 shadow-sm">
                          {t(`properties.rental.${p.rental_type}`)}
                        </span>
                      )}
                    </div>
                    {/* Info */}
                    <div className="p-3">
                      <p className="font-semibold text-hp-black font-body text-sm truncate">
                        {p.project_name}
                        {p.unit_number && (
                          <span className="ml-1.5 text-gray-400 font-normal text-xs">· {p.unit_number}</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400 font-body mt-0.5">📍 {p.city || '—'}</p>
                    </div>
                  </Link>
                )
              })}
            </div>
            {properties.length > 4 && (
              <div className="px-5 pb-5">
                <Link
                  to="/eigentuemer/properties"
                  className="block w-full py-2.5 text-center text-xs font-medium font-body
                             rounded-xl border border-gray-200 text-gray-500
                             hover:border-hp-highlight hover:text-hp-black transition-colors">
                  {t('eigentuemer.showMore', '+ {{n}} weitere anzeigen', { n: properties.length - 4 })}
                </Link>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Neuigkeiten & Dokumente von Happy Property ────── */}
      {(ownerDocs.length > 0 || newsError) && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mt-8">
          <div className="px-6 py-5 border-b border-gray-50 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-hp-black font-body text-base">📢 {t('eigentuemer.news.title', 'Neuigkeiten & Dokumente')}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{t('eigentuemer.news.subtitle', 'Videos und Unterlagen von Sven — z.B. zum Weiterleiten an deinen Steuerberater.')}</p>
            </div>
            <Link to="/eigentuemer/downloads"
              className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50">
              {t('eigentuemer.news.allDownloads', 'Alle ansehen →')}
            </Link>
          </div>
          {newsError && ownerDocs.length === 0 ? (
            <p className="p-5 text-sm text-gray-400">⚠️ {t('eigentuemer.news.loadError', 'Konnte nicht geladen werden.')}</p>
          ) : (
          <div className="p-5 space-y-4">
            {ownerDocs.map(d => {
              const isNew = Date.now() - new Date(d.created_at).getTime() < 14 * 864e5
              return (
                <div key={d.id} className="border border-gray-100 rounded-2xl overflow-hidden">
                  <div className="flex items-center gap-3 p-4">
                    <span className="text-2xl shrink-0">{d.kind === 'video' ? '🎬' : '📄'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-hp-black font-body text-sm">{d.title}
                        {isNew && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full text-white font-semibold" style={{ backgroundColor: '#ff795d' }}>{t('eigentuemer.news.new', 'NEU')}</span>}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{new Date(d.created_at).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}</p>
                    </div>
                    {d.kind !== 'video' && (
                      <a href={d.file_url} target="_blank" rel="noreferrer"
                        className="shrink-0 text-xs font-semibold px-4 py-2 rounded-xl text-white" style={{ backgroundColor: '#ff795d' }}>
                        ⬇️ {t('eigentuemer.news.open', 'Öffnen')}
                      </a>
                    )}
                  </div>
                  {d.kind === 'video' && (
                    <video controls preload="metadata" className="w-full max-h-[420px] bg-black" src={d.file_url} />
                  )}
                </div>
              )
            })}
          </div>
          )}
        </div>
      )}

      {/* ── Problem melden ─────────────────────────────────── */}
      <div className="mt-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold text-hp-black font-body text-sm">🐞 {t('eigentuemer.bug.cardTitle', 'Etwas funktioniert nicht?')}</p>
          <p className="text-xs text-gray-400 mt-0.5">{t('eigentuemer.bug.cardSub', 'Sag uns Bescheid — mit Screenshot, wenn möglich. Wir kümmern uns und melden uns, sobald es behoben ist.')}</p>
        </div>
        <button onClick={() => setShowBug(true)} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
          {t('eigentuemer.bug.cardBtn', 'Problem melden')}
        </button>
      </div>
      {showBug && <BugModal onClose={() => setShowBug(false)} onDone={m => { setShowBug(false); setBugToast(m); setTimeout(() => setBugToast(''), 8000) }} />}
      {bugToast && <div className="fixed bottom-6 right-6 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 max-w-sm">{bugToast}</div>}

    </DashboardLayout>
  )
}
