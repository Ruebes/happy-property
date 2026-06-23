import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import type { CrmProject, ProjectStatus, DeckAssetsCache } from '../../../lib/crmTypes'
import { PROJECT_STATUS_COLORS } from '../../../lib/crmTypes'
import { CustomSelect } from '../../../components/CustomSelect'
import { NumberStepper } from '../../../components/NumberStepper'
import ConstructionPhotos from '../../../components/crm/ConstructionPhotos'
import UnitImagesUploader from '../../../components/crm/UnitImagesUploader'

const STORAGE_BUCKET = 'crm-project-images'

// ── Image Upload Helpers ─────────────────────────────────────────────────────

async function uploadImages(files: File[]): Promise<string[]> {
  const urls: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `projects/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false })
    if (!error) {
      const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
      urls.push(data.publicUrl)
    }
  }
  return urls
}

async function deleteStorageImage(url: string) {
  // Extract storage path from public URL
  const marker = `/${STORAGE_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return
  const path = url.slice(idx + marker.length)
  await supabase.storage.from(STORAGE_BUCKET).remove([path])
}

// ── Project Modal ────────────────────────────────────────────────────────────

interface ProjectForm {
  name:           string
  developer:      string
  status:         ProjectStatus
  completion_date: string
  description_de: string
  description_en: string
  location:       string
  maps_url:       string
  latitude:       number | null
  longitude:      number | null
  equipment_list: string
  furniture_cost:     string   // € netto; leer = nicht gesetzt
  furniture_included: boolean  // im Kaufpreis enthalten
  video_url:      string
  drive_folder_id: string
}

interface ProjectModalProps {
  project: CrmProject | null   // null = new
  onClose: () => void
  onSaved: () => void
}

function parseGoogleMapsLocation(input: string): string {
  const coordMatch = input.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (coordMatch) return `${coordMatch[1]},${coordMatch[2]}`
  const qMatch = input.match(/[?&]q=([^&]+)/)
  if (qMatch) return decodeURIComponent(qMatch[1])
  if (input.startsWith('http')) return input
  return input
}

function ProjectModal({ project, onClose, onSaved }: ProjectModalProps) {
  const { t } = useTranslation()
  const [saving, setSaving]             = useState(false)
  const [saveError, setSaveError]       = useState<string | null>(null)
  const [developers, setDevelopers]     = useState<{ id: string; name: string }[]>([])
  const [devLoading, setDevLoading]     = useState(true)

  useEffect(() => {
    async function loadDevs() {
      setDevLoading(true)
      try {
        const { data, error } = await supabase
          .from('crm_developers')
          .select('id, name')
          .order('name')
        if (error) throw error
        setDevelopers(data ?? [])
      } catch (err) {
        console.error('[ProjectModal] loadDevelopers:', err)
        setDevelopers([])
      } finally {
        setDevLoading(false)
      }
    }
    loadDevs()
  }, [])
  const [activeTab, setActiveTab] = useState<'basic' | 'location' | 'media'>('basic')
  const [form, setForm] = useState<ProjectForm>({
    name:            project?.name ?? '',
    developer:       project?.developer ?? '',
    status:          project?.status ?? 'available',
    completion_date: project?.completion_date ?? '',
    description_de:  project?.description_de ?? '',
    description_en:  project?.description_en ?? '',
    location:        project?.location ?? '',
    maps_url:        project?.maps_url ?? '',
    latitude:        project?.latitude ?? null,
    longitude:       project?.longitude ?? null,
    equipment_list:  project?.equipment_list ?? '',
    furniture_cost:     project?.furniture_cost != null ? String(project.furniture_cost) : '',
    furniture_included: project?.furniture_included ?? false,
    video_url:       project?.video_url ?? '',
    drive_folder_id: project?.drive_folder_id ?? '',
  })
  const [resolvingPin, setResolvingPin] = useState(false)
  const [pinMsg,       setPinMsg]       = useState('')
  const [images, setImages]     = useState<string[]>(project?.images ?? [])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)

  // ── Deck-Assets aus Google Drive importieren (prepare-project-assets) ──────────
  const [ingesting, setIngesting] = useState(false)
  const [ingestMsg, setIngestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const runIngest = async () => {
    if (!project?.id) return
    setIngesting(true)
    setIngestMsg(null)
    const steps: { action: 'images' | 'categorize' | 'docs' | 'brochure' | 'facts'; label: string }[] = [
      { action: 'images',     label: t('crm.project.deck.stepImages',     'Bilder & Grundrisse') },
      { action: 'categorize', label: t('crm.project.deck.stepCategorize', 'Bilder einsortieren (Räume)') },
      { action: 'docs',       label: t('crm.project.deck.stepDocs',       'Dokumente') },
      { action: 'brochure',   label: t('crm.project.deck.stepBrochure',   'Broschüre auswerten (Innenbilder)') },
      { action: 'facts',      label: t('crm.project.deck.stepFacts',      'Fakten (KI liest Broschüre)') },
    ]
    try {
      const summary: string[] = []
      // Drive-Ordner automatisch finden, falls keiner verknüpft ist (Projekte/Developer/Projekt)
      let folderId = form.drive_folder_id.trim()
      if (!folderId) {
        setIngestMsg({ ok: true, text: `⏳ ${t('crm.project.deck.resolving', 'Drive-Ordner suchen…')}` })
        const { data, error } = await supabase.functions.invoke('prepare-project-assets', { body: { project_id: project.id, action: 'resolve' } })
        if (error) throw new Error(error.message)
        const rd = data as { found?: boolean; folder_id?: string; hint?: string; error?: string }
        if (rd?.error) throw new Error(rd.error)
        if (rd?.found && rd.folder_id) { folderId = rd.folder_id; up('drive_folder_id', folderId) }
        else {
          setIngestMsg({ ok: false, text: `${t('crm.project.deck.noFolder', 'Kein passender Drive-Ordner gefunden.')} ${rd?.hint ? t('crm.project.deck.available', 'Verfügbar') + ': ' + rd.hint + '. ' : ''}${t('crm.project.deck.enterManually', 'Bitte Ordner-ID manuell eintragen.')}` })
          setIngesting(false)
          return
        }
      }
      for (const { action, label } of steps) {
        setIngestMsg({ ok: true, text: `⏳ ${label}…` })
        const { data, error } = await supabase.functions.invoke('prepare-project-assets', {
          body: { project_id: project.id, action, folder_id: folderId || undefined },
        })
        if (error) throw new Error(error.message)
        const d = data as { error?: string; renders?: number; floorplans?: number; unitsMatched?: number; gallery?: number; found?: Record<string, boolean>; facts_chars?: number; background?: boolean; extracted?: number; uploaded?: number }
        if (d?.error) throw new Error(d.error)
        if (action === 'images')     summary.push(`${d.renders ?? 0} Bilder, ${d.floorplans ?? 0} Grundrisse (${d.unitsMatched ?? 0} Units zugeordnet)`)
        if (action === 'categorize') summary.push(`${d.gallery ?? 0} Bilder einsortiert`)
        if (action === 'docs')       summary.push(`Dokumente: ${Object.entries(d.found ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'keine'}`)
        if (action === 'brochure')   summary.push(`${d.extracted ?? 0} Broschüren-Bilder (${d.gallery ?? 0} in Gallery)`)
        if (action === 'facts')      summary.push(d.background ? t('crm.project.deck.factsBackground', 'Fakten laufen im Hintergrund (~1 Min)') : `Fakten ${d.facts_chars ?? 0} Zeichen`)
      }
      // Vollausstattung (xlsx-Spec) → Text, in eigener schlanker Funktion (memory-sicher)
      void supabase.functions.invoke('parse-spec-xlsx', { body: { project_id: project.id } }).catch(() => {})
      // Wohnungen aus der Preisliste anlegen (Vorschlags-Pool, nur im Deck-Wizard sichtbar) — im Hintergrund
      setIngestMsg({ ok: true, text: `⏳ ${t('crm.project.deck.stepUnits', 'Wohnungen aus Preisliste')}…` })
      try {
        const { data: ud, error: uerr } = await supabase.functions.invoke('parse-pricelist', { body: { project_id: project.id, create: true, background: true } })
        const u = (ud ?? {}) as { background?: boolean; created?: number; error?: string }
        if (uerr || u.error) summary.push(`${t('crm.project.deck.stepUnits', 'Wohnungen')}: ${u.error ?? uerr?.message ?? 'Fehler'}`)
        else summary.push(u.background ? t('crm.project.deck.unitsBackground', 'Wohnungen werden im Hintergrund angelegt') : `${u.created ?? 0} ${t('crm.project.deck.unitsCreated', 'Wohnungen angelegt')}`)
      } catch { summary.push(`${t('crm.project.deck.stepUnits', 'Wohnungen')}: —`) }
      setIngestMsg({ ok: true, text: `✓ ${summary.join(' · ')}` })
    } catch (e) {
      setIngestMsg({ ok: false, text: e instanceof Error ? e.message : 'Fehler beim Import' })
    } finally {
      setIngesting(false)
    }
  }

  // ── Generisches Projekt-Deck erzeugen (neutral, für Zoom) ─────────────────────
  const [deckBusy, setDeckBusy] = useState(false)
  const [deckMsg, setDeckMsg]   = useState<{ ok: boolean; text: string; token?: string } | null>(null)
  const [refineInput, setRefineInput] = useState('')
  const [refineBusy,  setRefineBusy]  = useState(false)
  const [refineLearn, setRefineLearn] = useState(false)
  const [refineMsg,   setRefineMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  const runGenericDeck = async () => {
    if (!project?.id) return
    setDeckBusy(true)
    setDeckMsg(null)
    try {
      // Frische Assets holen — Fakten + Deck laufen im Hintergrund, der project-Prop ist evtl. veraltet.
      const { data: fresh } = await supabase.from('crm_projects').select('deck_assets, deck_token').eq('id', project.id).maybeSingle()
      const da = ((fresh?.deck_assets ?? project.deck_assets) ?? null) as DeckAssetsCache | null
      if (!da?.facts) { setDeckMsg({ ok: false, text: t('crm.project.deck.factsPending', 'Fakten noch nicht fertig (laufen im Hintergrund) — bitte 1 Minute warten und erneut.') }); setDeckBusy(false); return }
      const prevToken = ((fresh?.deck_token as string | null) ?? project.deck_token) ?? null
      const images = { renders: da.renders ?? [], gallery: da.gallery ?? [], floorplan: da.floorplans?.[0]?.url, map: da.map ?? undefined, mapUrl: da.mapUrl ?? undefined, mapMarker: da.mapMarker ?? undefined }
      const month = new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
      setDeckMsg({ ok: true, text: `⏳ ${t('crm.project.deck.deckLoading', 'Erstelle Deck…')}` })
      const { data, error } = await supabase.functions.invoke('generate-deck', {
        body: { generic: true, background: true, project_id: project.id, facts: da.facts, images, month_label: month },
      })
      if (error) throw new Error(error.message)
      const d = data as { token?: string; background?: boolean; error?: string }
      if (d?.error) throw new Error(d.error)
      // Hintergrund-Generierung (~80s): auf den neuen deck_token am Projekt pollen.
      let token = d.token ?? null
      if (!token && d.background) {
        for (let i = 0; i < 30 && !token; i++) {
          await new Promise(r => setTimeout(r, 5000))
          const { data: pr } = await supabase.from('crm_projects').select('deck_token').eq('id', project.id).maybeSingle()
          const nt = (pr?.deck_token as string | null) ?? null
          if (nt && nt !== prevToken) token = nt
        }
      }
      if (!token) { setDeckMsg({ ok: false, text: t('crm.project.deck.deckTimeout', 'Deck dauert ungewöhnlich lange — bitte gleich nochmal „Deck öffnen" prüfen.') }); return }
      setDeckMsg({ ok: true, text: t('crm.project.deck.deckReady', 'Allgemeines Deck erstellt.'), token })
    } catch (e) {
      setDeckMsg({ ok: false, text: e instanceof Error ? e.message : 'Fehler' })
    } finally {
      setDeckBusy(false)
    }
  }

  // Deck-Feinschliff: Freitext-Anweisung an die KI (Token bleibt stabil) bzw. Undo
  const runRefine = async (undo = false) => {
    const token = deckMsg?.token ?? project?.deck_token
    if (!token || refineBusy) return
    if (!undo && !refineInput.trim()) return
    setRefineBusy(true); setRefineMsg(null)
    try {
      if (undo) {
        const { data, error } = await supabase.functions.invoke('refine-deck', { body: { token, action: 'undo' } })
        if (error) throw new Error(error.message)
        const d = data as { error?: string }
        if (d?.error) throw new Error(d.error)
        setRefineMsg({ ok: true, text: t('crm.project.deck.refineUndone', 'Letzte Änderung rückgängig gemacht.') })
      } else {
        // Hintergrund-Lauf (sonst Edge-Timeout „Failed to send a request") → auf Fertig pollen.
        const learnedNow = refineLearn
        const { data, error } = await supabase.functions.invoke('refine-deck', { body: { token, instruction: refineInput.trim(), learn: refineLearn, background: true } })
        if (error) throw new Error(error.message)
        const d = data as { error?: string }
        if (d?.error) throw new Error(d.error)
        setRefineInput('')
        setRefineMsg({ ok: true, text: '⏳ ' + t('crm.project.deck.refineRunning', 'Wird im Hintergrund angepasst…') })
        for (let i = 0; i < 45; i++) {
          await new Promise(r => setTimeout(r, 4000))
          const { data: row } = await supabase.from('sales_decks').select('refining, refine_error').eq('token', token).maybeSingle()
          const r2 = row as { refining?: boolean; refine_error?: string | null } | null
          if (!r2 || r2.refining === false) {
            if (r2?.refine_error) throw new Error(r2.refine_error)
            setRefineMsg({ ok: true, text: t('crm.project.deck.refineDone', '✅ Deck angepasst — Deck neu öffnen zum Prüfen.') + (learnedNow ? ' (gemerkt für alle Decks)' : '') })
            break
          }
        }
      }
    } catch (e) {
      setRefineMsg({ ok: false, text: e instanceof Error ? e.message : 'Fehler' })
    } finally {
      setRefineBusy(false)
    }
  }
  const fileInputRef = useRef<HTMLInputElement>(null)

  const up = (k: keyof ProjectForm, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  // Google-Maps-Link (auch Kurzlink) → Koordinaten via Edge Function auflösen.
  const resolvePin = async () => {
    const link = form.maps_url.trim()
    if (!link) { setPinMsg(''); return }
    setResolvingPin(true); setPinMsg('')
    try {
      const { data, error } = await supabase.functions.invoke('resolve-maps-link', { body: { url: link } })
      if (error) throw error
      const r = data as { success: boolean; lat?: number; lng?: number; error?: string }
      if (!r.success || r.lat == null || r.lng == null) {
        throw new Error(r.error || t('crm.project.mapsPinFail', 'Konnte den Link nicht auflösen'))
      }
      setForm(prev => ({ ...prev, latitude: r.lat ?? null, longitude: r.lng ?? null }))
      setPinMsg(`✓ ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`)
    } catch (err) {
      setPinMsg(`❌ ${err instanceof Error ? err.message : 'Fehler'}`)
    } finally {
      setResolvingPin(false)
    }
  }

  // ── Image upload ──────────────────────────────────────────────
  const handleImageFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    try {
      const urls = await uploadImages(files)
      setImages(prev => [...prev, ...urls])
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    await handleImageFiles(files)
  }

  const handleDeleteImage = async (url: string) => {
    await deleteStorageImage(url)
    setImages(prev => prev.filter(u => u !== url))
  }

  // ── Save project ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    setSaveError(null)

    // Timeout-Fallback: verhindert endlosen Spinner bei hängender Netzwerkanfrage
    // Promise.resolve() wandelt PromiseLike (Supabase) in echtes Promise um
    const timeoutMs = 15_000
    const withTimeout = <T,>(p: PromiseLike<T>): Promise<T> =>
      Promise.race([
        Promise.resolve(p),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout – Verbindung zu langsam. Bitte erneut versuchen.')), timeoutMs)
        ),
      ])

    try {
      const payload = {
        name:            form.name.trim(),
        developer:       form.developer.trim() || null,
        status:          form.status,
        completion_date: form.completion_date || null,
        description_de:  form.description_de.trim() || null,
        description_en:  form.description_en.trim() || null,
        location:        form.location.trim() || null,
        maps_url:        form.maps_url.trim() || null,
        latitude:        form.latitude,
        longitude:       form.longitude,
        equipment_list:  form.equipment_list.trim() || null,
        furniture_cost:     form.furniture_cost.trim() ? Number(form.furniture_cost.replace(/[^\d.]/g, '')) || null : null,
        furniture_included: form.furniture_included,
        video_url:       form.video_url.trim() || null,
        drive_folder_id: form.drive_folder_id.trim() || null,
        images,
      }
      type DbResult = { error: { message: string } | null }
      if (project?.id) {
        const res = await withTimeout(
          supabase.from('crm_projects').update(payload).eq('id', project.id)
        ) as DbResult
        if (res.error) throw new Error(res.error.message)

        // Status-Kaskade: Wenn Projektstatus sich geändert hat →
        // alle CRM-Einheiten + verlinkten Portal-Einträge aktualisieren
        if (project.status !== form.status) {
          const newUnitStatus = form.status === 'under_construction' ? 'under_construction' : 'active'
          const newPropStatus = newUnitStatus

          // 1. Alle CRM-Einheiten dieses Projekts updaten
          const { error: unitStatusErr } = await supabase
            .from('crm_project_units')
            .update({ status: newUnitStatus })
            .eq('project_id', project.id)
          if (unitStatusErr) throw new Error(unitStatusErr.message)

          // 2. Verknüpfte Portal-Einträge (property_status) ebenfalls updaten
          const { data: units } = await supabase
            .from('crm_project_units')
            .select('property_id')
            .eq('project_id', project.id)
            .not('property_id', 'is', null)
          if (units && units.length > 0) {
            const propertyIds = (units as { property_id: string }[]).map(u => u.property_id)
            const { error: propStatusErr } = await supabase
              .from('properties')
              .update({ property_status: newPropStatus })
              .in('id', propertyIds)
            if (propStatusErr) throw new Error(propStatusErr.message)
          }
        }
      } else {
        const res = await withTimeout(
          supabase.from('crm_projects').insert(payload)
        ) as DbResult
        if (res.error) throw new Error(res.error.message)
      }
      onSaved()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unbekannter Fehler'
      setSaveError(msg)
      console.error('[ProjectModal] handleSave:', err)
    } finally {
      setSaving(false)
    }
  }

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'basic',    label: t('crm.project.tabs.basic',    'Grunddaten') },
    { id: 'location', label: t('crm.project.tabs.location', 'Lage') },
    { id: 'media',    label: t('crm.project.tabs.media',    'Medien') + (images.length ? ` (${images.length})` : '') },
  ]

  // Video embed URL helper
  const getEmbedUrl = (url: string) => {
    const ytMatch    = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
    const vimeoMatch = url.match(/vimeo\.com\/(\d+)/)
    if (ytMatch)    return `https://www.youtube.com/embed/${ytMatch[1]}`
    if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {project
              ? t('crm.project.edit', 'Projekt bearbeiten')
              : t('crm.project.new', '+ Neues Projekt')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-orange-500 text-orange-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Grunddaten ── */}
          {activeTab === 'basic' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.name', 'Projektname')} *
                </label>
                <input value={form.name} onChange={e => up('name', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="z.B. Infinity" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.project.developer', 'Entwickler / Developer')}
                  </label>
                  <CustomSelect
                    value={form.developer}
                    onChange={val => up('developer', val)}
                    disabled={devLoading}
                    className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                    placeholder={devLoading ? 'Wird geladen…' : developers.length === 0 ? 'Keine Developer angelegt' : '— Developer wählen —'}
                    options={developers.map(d => ({ value: d.name, label: d.name }))}
                  />
                  {!devLoading && developers.length === 0 && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      Noch keine Developer angelegt → CRM → Einstellungen → Developer hinzufügen
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.project.status', 'Status')}
                  </label>
                  <CustomSelect
                    value={form.status}
                    onChange={val => up('status', val as ProjectStatus)}
                    className="w-full border border-gray-200 rounded-lg text-sm"
                    options={(['available', 'under_construction', 'sold_out', 'completed'] as ProjectStatus[]).map(s => ({ value: s, label: t(`crm.project.statuses.${s}`, s) }))}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.completion', 'Geplante Fertigstellung')}
                </label>
                <input type="date" value={form.completion_date} onChange={e => up('completion_date', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.descriptionDe', 'Beschreibung (Deutsch)')}
                </label>
                <textarea rows={4} value={form.description_de} onChange={e => up('description_de', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.descriptionEn', 'Beschreibung (Englisch)')}
                </label>
                <textarea rows={4} value={form.description_en} onChange={e => up('description_en', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.equipment', 'Ausstattungsliste')}
                </label>
                <textarea rows={4} value={form.equipment_list} onChange={e => up('equipment_list', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                  placeholder="z.B. Klimaanlage, Pool, Smart Home, Tiefgarage…" />
              </div>

              {/* Einrichtungspaket: Default für die Möbel-AfA in jeder Rendite-Berechnung
                  dieses Projekts (Wizard zieht sich den Wert hier raus). */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.furniture', 'Einrichtungspaket (Möbel)')}
                </label>
                <label className="flex items-center gap-2 mb-2 text-sm text-gray-700 cursor-pointer select-none">
                  <input type="checkbox" checked={form.furniture_included}
                    onChange={e => setForm(prev => ({ ...prev, furniture_included: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
                  {t('crm.project.furnitureIncluded', 'Möbel im Kaufpreis enthalten (kostenfrei)')}
                </label>
                {!form.furniture_included && (
                  <div className="relative max-w-[220px]">
                    <input type="number" step="500" value={form.furniture_cost}
                      onChange={e => up('furniture_cost', e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                      placeholder="z.B. 19000" />
                    <span className="absolute right-3 top-2.5 text-sm text-gray-400">€ netto</span>
                  </div>
                )}
                <p className="mt-1 text-xs text-gray-400">
                  {t('crm.project.furnitureHint', 'Wird automatisch als Möbel-AfA in alle Berechnungen dieses Projekts übernommen.')}
                </p>
              </div>
            </>
          )}

          {/* ── Lage ── */}
          {activeTab === 'location' && (() => {
            const hasCoords = form.latitude != null && form.longitude != null
            const mapQuery  = hasCoords ? `${form.latitude},${form.longitude}` : parseGoogleMapsLocation(form.location)
            const hasMap    = hasCoords || !!form.location.trim()
            const openHref  = form.maps_url.trim()
              || (hasCoords ? `https://maps.google.com/?q=${form.latitude},${form.longitude}`
                            : `https://maps.google.com/?q=${encodeURIComponent(form.location)}`)
            return (
            <>
              {/* Google Maps Pin (Link — auch Kurzlink) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  📍 {t('crm.project.mapsPin', 'Google Maps Pin (Link)')}
                </label>
                <input value={form.maps_url}
                  onChange={e => { up('maps_url', e.target.value); setPinMsg('') }}
                  onBlur={resolvePin}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="https://maps.app.goo.gl/…" />
                <p className={`text-xs mt-1 ${pinMsg.startsWith('❌') ? 'text-red-500' : pinMsg.startsWith('✓') ? 'text-green-600' : 'text-gray-400'}`}>
                  {resolvingPin
                    ? t('crm.project.mapsPinResolving', 'Pin wird aufgelöst…')
                    : pinMsg || t('crm.project.mapsPinHint', 'Google-Maps-Link einfügen (auch Kurzlink) — Pin wird automatisch übernommen.')}
                </p>
              </div>

              {/* Adresse (optional, lesbarer Text) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.location', 'Standort / Adresse')}
                </label>
                <input value={form.location} onChange={e => up('location', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="z.B. Paphos, Zypern" />
                <p className="text-xs text-gray-400 mt-1">
                  {t('crm.project.locationOptional', 'Optional — für die Text-Anzeige. Der Pin oben bestimmt die Karte.')}
                </p>
              </div>

              {hasMap ? (
                <>
                  <div className="rounded-xl overflow-hidden border border-gray-200">
                    <iframe
                      title="map"
                      width="100%"
                      height="280"
                      loading="lazy"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed&z=15`}
                      style={{ border: 0 }}
                    />
                  </div>
                  <a
                    href={openHref}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-orange-500 hover:underline font-medium"
                  >
                    🗺 {t('crm.project.openInMaps', 'In Google Maps öffnen')}
                  </a>
                </>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">
                  {t('crm.project.enterLocationFirst', 'Pin-Link oder Adresse eingeben, um die Karte zu zeigen.')}
                </p>
              )}
            </>
            )
          })()}

          {/* ── Medien ── */}
          {activeTab === 'media' && (
            <>
              {/* Drop zone */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('crm.project.images', 'Bilder')}
                </label>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragOver
                      ? 'border-orange-400 bg-orange-50'
                      : 'border-gray-200 hover:border-orange-300 hover:bg-orange-50/30'
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="text-3xl mb-2">🖼</div>
                  <p className="text-sm font-medium text-gray-600">
                    {uploading
                      ? t('crm.project.uploading', 'Lädt hoch…')
                      : t('crm.project.dropImages', 'Bilder hierher ziehen oder klicken')}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{t('crm.project.imageFormats', 'PNG, JPG, WEBP — mehrere möglich')}</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => handleImageFiles(Array.from(e.target.files ?? []))}
                />
              </div>

              {/* Gallery */}
              {images.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
                    {images.length} {t('crm.project.imagesUploaded', 'Bilder')}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {images.map((url, idx) => (
                      <div key={idx} className="relative group aspect-video rounded-lg overflow-hidden border border-gray-100">
                        <img src={url} alt="" className="w-full h-full object-cover" />
                        <button
                          onClick={() => handleDeleteImage(url)}
                          className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs
                                     flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                                     hover:bg-red-600"
                          title={t('crm.project.deleteImage', 'Bild löschen')}
                        >
                          ✕
                        </button>
                        {idx === 0 && (
                          <span className="absolute bottom-1 left-1 text-xs bg-black/60 text-white px-1.5 py-0.5 rounded">
                            {t('crm.project.mainImage', 'Hauptbild')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Video URL */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.videoUrl', 'Video URL (YouTube / Vimeo)')}
                </label>
                <input value={form.video_url} onChange={e => up('video_url', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="https://youtube.com/watch?v=…" />
              </div>

              {form.video_url && (() => {
                const embedUrl = getEmbedUrl(form.video_url)
                if (!embedUrl) return (
                  <p className="text-xs text-red-500">
                    {t('crm.project.invalidVideoUrl', 'Ungültige Video-URL (YouTube oder Vimeo)')}
                  </p>
                )
                return (
                  <div className="rounded-xl overflow-hidden border border-gray-200">
                    <iframe
                      title="video"
                      width="100%"
                      height="240"
                      src={embedUrl}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      style={{ border: 0 }}
                    />
                  </div>
                )
              })()}

              {/* Sales-Deck-Assets aus Google Drive */}
              <div className="border-t border-gray-100 pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.deck.title', 'Sales-Deck-Assets (Google Drive)')}
                </label>
                <p className="text-xs text-gray-400 mb-2">
                  {t('crm.project.deck.help', 'Drive-Ordner-ID des Projekts. Der Import zieht automatisch Renders, Grundrisse (je Etage), Broschüre, Einrichtung/Besteck/Wäsche und erzeugt apartment-sichere Fakten.')}
                </p>
                <div className="flex gap-2">
                  <input value={form.drive_folder_id} onChange={e => up('drive_folder_id', e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-400"
                    placeholder="z.B. 19wlu6PSKy14un9EJeTFZWtPAbpkk-4nU" />
                  <button
                    type="button"
                    onClick={runIngest}
                    disabled={ingesting || !project?.id}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {ingesting ? t('crm.project.deck.loading', 'Lädt…') : t('crm.project.deck.load', 'Aus Drive laden')}
                  </button>
                </div>
                {!project?.id && (
                  <p className="text-xs text-amber-600 mt-1.5">{t('crm.project.deck.saveFirst', 'Projekt zuerst speichern, dann Assets laden.')}</p>
                )}
                {ingestMsg && (
                  <p className={`text-xs mt-2 rounded-lg px-3 py-2 ${ingestMsg.ok ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
                    {ingestMsg.text}
                  </p>
                )}
                {project?.deck_assets?.updated_at && !ingestMsg && (
                  <p className="text-xs text-gray-400 mt-2">
                    {t('crm.project.deck.cached', 'Im Cache')}: {project.deck_assets.renders?.length ?? 0} Bilder · {project.deck_assets.floorplans?.length ?? 0} Grundrisse · {project.deck_assets.facts ? t('crm.project.deck.factsReady', 'Fakten ✓') : t('crm.project.deck.factsMissing', 'Fakten fehlen')}
                  </p>
                )}

                {/* Generisches Projekt-Deck (zum Teilen im Zoom) */}
                {project?.id && (project.deck_assets || form.drive_folder_id.trim()) && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={runGenericDeck}
                        disabled={deckBusy}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {deckBusy
                          ? t('crm.project.deck.deckLoading', 'Erstelle Deck…')
                          : (project.deck_token ? t('crm.project.deck.regen', 'Allgemeines Deck neu erzeugen') : t('crm.project.deck.gen', 'Allgemeines Deck erzeugen'))}
                      </button>
                      {(deckMsg?.token || project.deck_token) && (
                        <a href={`/deck/${deckMsg?.token ?? project.deck_token}`} target="_blank" rel="noopener noreferrer"
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 text-white hover:bg-gray-800">
                          {t('crm.project.deck.openDeck', 'Deck öffnen (Zoom)')} ↗
                        </a>
                      )}
                    </div>
                    {deckMsg && (
                      <p className={`text-xs mt-2 rounded-lg px-3 py-2 ${deckMsg.ok ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>{deckMsg.text}</p>
                    )}

                    {/* Deck-Feinschliff (KI) — nur wenn ein Deck existiert */}
                    {(deckMsg?.token || project.deck_token) && (
                      <div className="mt-3 border-t border-gray-100 pt-3">
                        <label className="block text-xs font-semibold text-gray-700 mb-1">💬 {t('crm.project.deck.refineTitle', 'Deck-Feinschliff (KI)')}</label>
                        <p className="text-[11px] text-gray-400 mb-1.5">{t('crm.project.deck.refineHint', 'Sag, was geändert werden soll — z.B. „Karte als eigene Kachel", „Titelbild aufs Pool-Foto", „Einleitung kürzer".')}</p>
                        <textarea rows={2} value={refineInput} onChange={e => setRefineInput(e.target.value)} disabled={refineBusy}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-y disabled:opacity-50"
                          placeholder={t('crm.project.deck.refinePh', 'Änderung beschreiben…')} />
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          <button type="button" onClick={() => runRefine(false)} disabled={refineBusy || !refineInput.trim()}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                            {refineBusy ? t('crm.project.deck.refineBusy', 'KI passt an…') : t('crm.project.deck.refineApply', 'Anwenden')}
                          </button>
                          <button type="button" onClick={() => runRefine(true)} disabled={refineBusy}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                            ↩ {t('crm.project.deck.refineUndo', 'Rückgängig')}
                          </button>
                          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={refineLearn} onChange={e => setRefineLearn(e.target.checked)} className="w-3.5 h-3.5 accent-orange-500" />
                            {t('crm.project.deck.refineLearn', 'Für alle Decks merken')}
                          </label>
                        </div>
                        {refineMsg && (
                          <p className={`text-xs mt-2 rounded-lg px-3 py-2 ${refineMsg.ok ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>{refineMsg.text}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Baustellenbilder & -videos */}
              <div className="border-t border-gray-100 pt-4">
                {project?.id ? (
                  <ConstructionPhotos projectId={project.id} />
                ) : (
                  <p className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-xl">
                    {t('crm.project.saveFirstForConstruction', 'Projekt zuerst speichern, dann Baustellenbilder hochladen.')}
                  </p>
                )}
              </div>

              {/* Wohnungsbilder (Wohnung wählen → Bilder hochladen) */}
              {project?.id && (
                <div className="border-t border-gray-100 pt-4">
                  <UnitImagesUploader projectId={project.id} />
                </div>
              )}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-6 py-4 flex-shrink-0">
          {saveError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
              ❌ {saveError}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-800 border border-gray-200"
            >
              {t('common.cancel', 'Abbrechen')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || uploading}
              className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: '#ff795d' }}
            >
              {saving
                ? t('common.saving', 'Speichert…')
                : t('crm.project.save', 'Projekt speichern')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Projects Page ───────────────────────────────────────────────────────

export default function Projects() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [projects, setProjects]         = useState<CrmProject[]>([])
  const [loading, setLoading]           = useState(true)
  const [filterStatus, setFilterStatus] = useState('')
  const [search, setSearch]             = useState('')
  const [filterBed, setFilterBed]       = useState<'all' | '1' | '2' | '3' | '4'>('all')
  const [filterMin, setFilterMin]       = useState(0)
  const [filterMax, setFilterMax]       = useState(0)
  const [editProject, setEditProject]   = useState<CrmProject | null | undefined>(undefined)
  const [scanBusy, setScanBusy]         = useState(false)
  const [scanMsg, setScanMsg]           = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('crm_projects')
        .select('*, units:crm_project_units(id,status,bedrooms,price_net,price_gross)')
        .order('created_at', { ascending: false })
      if (error) throw error
      setProjects((data ?? []) as unknown as CrmProject[])
    } catch (err) {
      console.error('[Projects]', err)
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Preis-/Schlafzimmer-Filter: Projekt erscheint, wenn ≥1 ANBIETBARE Wohnung
  // (nicht verkauft/reserviert) zu Schlafzimmern UND Preis-Spanne passt.
  const unitFilterActive = filterBed !== 'all' || filterMin > 0 || filterMax > 0
  const projectHasMatch = (p: CrmProject) => {
    if (!unitFilterActive) return true
    const units = (p as unknown as { units?: Array<{ status: string | null; bedrooms: number | null; price_net: number | null; price_gross: number | null }> }).units ?? []
    return units.some(u => {
      if (u.status === 'sold' || u.status === 'reserved') return false
      if (filterBed !== 'all') {
        const bed = u.bedrooms ?? 0
        if (filterBed === '4' ? bed < 4 : String(u.bedrooms ?? '') !== filterBed) return false
      }
      const price = u.price_gross ?? u.price_net ?? 0
      if (filterMin > 0 && price < filterMin) return false
      if (filterMax > 0 && price > filterMax) return false
      return true
    })
  }

  const filtered = projects.filter(p => {
    if (filterStatus && p.status !== filterStatus) return false
    if (search) {
      const q = search.toLowerCase()
      if (!p.name.toLowerCase().includes(q) &&
          !(p.developer ?? '').toLowerCase().includes(q) &&
          !(p.location ?? '').toLowerCase().includes(q)) return false
    }
    if (!projectHasMatch(p)) return false
    return true
  })

  const handleDelete = async (id: string) => {
    if (!confirm(t('crm.project.confirmDelete', 'Projekt wirklich löschen?'))) return
    const { error } = await supabase.from('crm_projects').delete().eq('id', id)
    if (error) { alert(`Fehler beim Löschen: ${error.message}`); return }
    await fetchAll()
  }

  // Neue Projekte aus dem Google Drive ziehen (legt an + Assets/Deck im Hintergrund)
  const scanDrive = async () => {
    setScanBusy(true); setScanMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('scan-drive-projects', { body: { ingest: true } })
      if (error) throw new Error(error.message)
      const d = data as { created?: number; scanned?: number; error?: string }
      if (d?.error) throw new Error(d.error)
      setScanMsg(t('crm.project.scanResult', '✅ {{created}} neue(s) Projekt(e) angelegt ({{scanned}} im Drive gefunden). Bilder + Deck werden im Hintergrund erzeugt (ein paar Minuten).', { created: d.created ?? 0, scanned: d.scanned ?? 0 }))
      await fetchAll()
    } catch (e) {
      setScanMsg(`❌ ${e instanceof Error ? e.message : 'Fehler beim Scannen'}`)
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            {t('crm.project.title', 'Projekte')}
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={scanDrive}
              disabled={scanBusy}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-orange-300 text-orange-600 hover:bg-orange-50 disabled:opacity-50 transition-colors"
            >
              {scanBusy ? t('crm.project.scanning', 'Scanne Drive…') : `↻ ${t('crm.project.scanDrive', 'Neue Projekte aus Drive')}`}
            </button>
            <button
              onClick={() => setEditProject(null)}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-opacity"
              style={{ backgroundColor: '#ff795d' }}
            >
              + {t('crm.project.new', 'Neues Projekt')}
            </button>
          </div>
        </div>

        {scanMsg && (
          <div className={`text-sm rounded-xl px-4 py-3 ${scanMsg.startsWith('❌') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {scanMsg}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex gap-3 flex-wrap items-end">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('crm.project.search', 'Suchen nach Name, Developer, Ort…')}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 min-w-[220px] self-center"
          />
          <CustomSelect
            value={filterStatus}
            onChange={val => setFilterStatus(val)}
            className="border border-gray-200 rounded-lg text-sm bg-white self-center"
            options={[
              { value: '', label: `— ${t('crm.project.allStatuses', 'Alle Status')} —` },
              ...(['available', 'under_construction', 'sold_out', 'completed'] as ProjectStatus[]).map(s => ({ value: s, label: t(`crm.project.statuses.${s}`, s) })),
            ]}
          />
          {/* Wohnungs-Filter: Schlafzimmer + Preis-Spanne */}
          <div>
            <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.project.bedrooms', 'Schlafzimmer')}</span>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              {(['all', '1', '2', '3', '4'] as const).map(b => (
                <button key={b} type="button" onClick={() => setFilterBed(b)}
                  className={`px-2.5 py-2 text-xs font-medium border-l first:border-l-0 border-gray-200 ${filterBed === b ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {b === 'all' ? t('crm.project.all', 'Alle') : b === '4' ? '4+' : b}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.project.priceFrom', 'Preis von')}</span>
            <NumberStepper value={filterMin} onChange={setFilterMin} step={25000} suffix="€" className="w-36" />
          </div>
          <div>
            <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.project.priceTo', 'bis')}</span>
            <NumberStepper value={filterMax} onChange={setFilterMax} step={25000} suffix="€" className="w-36" />
          </div>
          {unitFilterActive && (
            <button type="button" onClick={() => { setFilterBed('all'); setFilterMin(0); setFilterMax(0) }}
              className="text-xs text-gray-400 hover:text-gray-600 underline self-center pb-2">{t('crm.project.resetFilter', 'zurücksetzen')}</button>
          )}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-gray-400 text-center py-16">
            {(search || filterStatus || unitFilterActive)
              ? t('crm.project.noFilterMatch', 'Keine Projekte passen zum Filter.')
              : t('crm.project.noProjects', 'Noch keine Projekte angelegt.')}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map(p => {
              const totalUnits     = p.units?.length ?? 0
              const activeUnits = p.units?.filter((u: { status: string }) => u.status === 'active').length ?? 0
              const mainImage      = p.images?.[0]

              return (
                <div
                  key={p.id}
                  className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setEditProject(p)}
                >
                  {/* Image */}
                  <div className="h-44 bg-gradient-to-br from-gray-100 to-gray-200 overflow-hidden">
                    {mainImage
                      ? <img src={mainImage} alt={p.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-5xl">🏗</div>
                    }
                  </div>

                  <div className="p-4 space-y-2">
                    {/* Name + Status */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{p.name}</h3>
                        {p.developer && (
                          <p className="text-xs text-gray-500 truncate">{p.developer}</p>
                        )}
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${PROJECT_STATUS_COLORS[p.status]}`}>
                        {t(`crm.project.statuses.${p.status}`, p.status)}
                      </span>
                    </div>

                    {/* Location */}
                    {p.location && (
                      <p className="text-xs text-gray-500">📍 {p.location}</p>
                    )}

                    {/* Stats */}
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{totalUnits} Units</span>
                      {activeUnits > 0 && (
                        <span className="text-green-600 font-medium">{activeUnits} aktiv</span>
                      )}
                      {p.completion_date && (
                        <span>
                          {new Date(p.completion_date).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })}
                        </span>
                      )}
                      {p.images?.length > 0 && (
                        <span className="text-gray-400">🖼 {p.images.length}</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/admin/crm/projects/${p.id}`) }}
                        className="flex-1 text-center text-xs py-1.5 rounded-lg font-medium text-white transition-colors"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        🏠 Wohnungen
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditProject(p) }}
                        className="text-xs py-1.5 px-3 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                        className="text-xs py-1.5 px-3 rounded-lg border border-red-100 text-red-400 hover:bg-red-50 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Project Modal */}
      {editProject !== undefined && (
        <ProjectModal
          project={editProject}
          onClose={() => setEditProject(undefined)}
          onSaved={fetchAll}
        />
      )}
    </DashboardLayout>
  )
}
