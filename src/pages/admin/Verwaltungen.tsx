import { useState, useEffect, useCallback } from 'react'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'

// ── Types ──────────────────────────────────────────────────────
interface VerwaltungRecord {
  id:                    string
  name:                  string
  address_street:        string | null
  address_zip:           string | null
  address_city:          string | null
  address_country:       string | null
  phone:                 string | null
  email:                 string | null
  website:               string | null
  ansprechpartner:       string | null
  ansprechpartner_phone: string | null
  ansprechpartner_email: string | null
  notes:                 string | null
  created_at:            string
}

const EMPTY_FORM = {
  name:                  '',
  address_street:        '',
  address_zip:           '',
  address_city:          '',
  address_country:       'Deutschland',
  phone:                 '',
  email:                 '',
  website:               '',
  ansprechpartner:       '',
  ansprechpartner_phone: '',
  ansprechpartner_email: '',
  notes:                 '',
}

const inputCls = `w-full rounded-xl border border-gray-200 bg-white px-3 py-2
  text-sm text-hp-black font-body placeholder-gray-400
  focus:outline-none focus:ring-2 focus:border-transparent transition`

function focusRing(): React.CSSProperties {
  return { '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties
}

// ── Component ──────────────────────────────────────────────────
export default function AdminVerwaltungen() {
  const [list,    setList]    = useState<VerwaltungRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [toast,   setToast]   = useState<string | null>(null)

  const [modalOpen,  setModalOpen]  = useState(false)
  const [editing,    setEditing]    = useState<VerwaltungRecord | null>(null)
  const [form,       setForm]       = useState({ ...EMPTY_FORM })
  const [saving,     setSaving]     = useState(false)
  const [formError,  setFormError]  = useState('')
  const [deleteId,   setDeleteId]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase.from('verwaltungen').select('*').order('name')
      setList((data ?? []) as VerwaltungRecord[])
    } catch (err) {
      console.error('[Verwaltungen] load:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  function openCreate() {
    setEditing(null); setForm({ ...EMPTY_FORM }); setFormError(''); setModalOpen(true)
  }

  function openEdit(v: VerwaltungRecord) {
    setEditing(v)
    setForm({
      name:                  v.name,
      address_street:        v.address_street        ?? '',
      address_zip:           v.address_zip           ?? '',
      address_city:          v.address_city          ?? '',
      address_country:       v.address_country       ?? 'Deutschland',
      phone:                 v.phone                 ?? '',
      email:                 v.email                 ?? '',
      website:               v.website               ?? '',
      ansprechpartner:       v.ansprechpartner       ?? '',
      ansprechpartner_phone: v.ansprechpartner_phone ?? '',
      ansprechpartner_email: v.ansprechpartner_email ?? '',
      notes:                 v.notes                 ?? '',
    })
    setFormError(''); setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { setFormError('Firmenname ist Pflichtfeld.'); return }
    setSaving(true); setFormError('')
    const payload = {
      name:                  form.name.trim(),
      address_street:        form.address_street.trim()        || null,
      address_zip:           form.address_zip.trim()           || null,
      address_city:          form.address_city.trim()          || null,
      address_country:       form.address_country.trim()       || null,
      phone:                 form.phone.trim()                 || null,
      email:                 form.email.trim()                 || null,
      website:               form.website.trim()               || null,
      ansprechpartner:       form.ansprechpartner.trim()       || null,
      ansprechpartner_phone: form.ansprechpartner_phone.trim() || null,
      ansprechpartner_email: form.ansprechpartner_email.trim() || null,
      notes:                 form.notes.trim()                 || null,
      updated_at:            new Date().toISOString(),
    }
    let error
    if (editing) {
      ;({ error } = await supabase.from('verwaltungen').update(payload).eq('id', editing.id))
    } else {
      ;({ error } = await supabase.from('verwaltungen').insert(payload))
    }
    setSaving(false)
    if (error) { setFormError('Speichern fehlgeschlagen.'); return }
    setModalOpen(false)
    setToast(editing ? '✅ Verwaltung aktualisiert' : '✅ Verwaltung angelegt')
    load()
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from('verwaltungen').delete().eq('id', id)
    if (error) { setToast('❌ Löschen fehlgeschlagen'); return }
    setDeleteId(null); setToast('Verwaltung gelöscht'); load()
  }

  function mapsUrl(v: VerwaltungRecord) {
    const addr = [v.address_street, [v.address_zip, v.address_city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
  }

  return (
    <DashboardLayout basePath="/admin/dashboard">

      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-hp-black text-white text-sm font-body px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
            Verwaltungen
          </h1>
          <p className="text-sm text-gray-400 font-body mt-0.5">
            Verwaltungsunternehmen & Ansprechpartner pflegen
          </p>
        </div>
        <button onClick={openCreate}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold font-body text-white hover:opacity-90 transition-opacity"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
          + Neue Verwaltung
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 justify-center py-20 text-gray-400 font-body text-sm">
          <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          Lädt…
        </div>
      ) : list.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🏢</div>
          <p className="text-sm text-gray-500 font-body">Noch keine Verwaltungen angelegt.</p>
          <button onClick={openCreate}
                  className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold font-body text-white hover:opacity-90 transition-opacity"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
            Erste Verwaltung anlegen
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map(v => (
            <div key={v.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
              {/* Firmenname + Avatar */}
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-hp-black flex items-center justify-center text-white text-base font-bold shrink-0">
                  {v.name[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-hp-black font-body">{v.name}</p>
                  {v.address_city && <p className="text-xs text-gray-400 font-body mt-0.5">{v.address_city}</p>}
                </div>
              </div>

              {/* Firma-Kontakt */}
              <div className="space-y-1.5 text-sm font-body">
                {v.phone && (
                  <a href={`tel:${v.phone}`}
                     className="flex items-center gap-2 text-gray-600 hover:text-hp-highlight transition-colors">
                    <span>📞</span><span>{v.phone}</span>
                  </a>
                )}
                {v.email && (
                  <a href={`mailto:${v.email}`}
                     className="flex items-center gap-2 text-gray-600 hover:text-hp-highlight transition-colors truncate">
                    <span>✉️</span><span className="truncate">{v.email}</span>
                  </a>
                )}
                {(v.address_street || v.address_city) && (
                  <a href={mapsUrl(v)} target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-2 text-gray-600 hover:text-hp-highlight transition-colors">
                    <span>📍</span>
                    <span className="truncate">{[v.address_street, v.address_zip, v.address_city].filter(Boolean).join(', ')}</span>
                  </a>
                )}
              </div>

              {/* Ansprechpartner */}
              {v.ansprechpartner && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold font-body mb-1.5">
                    Ansprechpartner
                  </p>
                  <p className="text-sm font-semibold text-hp-black font-body">{v.ansprechpartner}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    {v.ansprechpartner_phone && (
                      <a href={`tel:${v.ansprechpartner_phone}`}
                         className="text-xs text-gray-500 hover:text-hp-highlight font-body transition-colors">
                        📞 {v.ansprechpartner_phone}
                      </a>
                    )}
                    {v.ansprechpartner_email && (
                      <a href={`mailto:${v.ansprechpartner_email}`}
                         className="text-xs text-gray-500 hover:text-hp-highlight font-body transition-colors">
                        ✉️ {v.ansprechpartner_email}
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <button onClick={() => openEdit(v)}
                        className="flex-1 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 font-body hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                  ✏️ Bearbeiten
                </button>
                <button onClick={() => setDeleteId(v.id)}
                        className="px-3 py-1.5 rounded-lg border border-red-100 text-xs font-semibold text-red-400 font-body hover:border-red-300 hover:text-red-600 transition-colors">
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal: Erstellen / Bearbeiten */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4 py-8 overflow-y-auto"
             onClick={e => { if (e.target === e.currentTarget) setModalOpen(false) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
                {editing ? 'Verwaltung bearbeiten' : 'Neue Verwaltung anlegen'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">

              {/* Firma */}
              <div>
                <p className="text-xs font-semibold text-gray-500 font-body mb-2 uppercase tracking-wide">Firma</p>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">Firmenname *</label>
                    <input autoFocus className={inputCls} style={focusRing()}
                           placeholder="z.B. Immobilien Management GmbH"
                           value={form.name}
                           onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <input className={inputCls} style={focusRing()} placeholder="Straße + Hausnummer"
                         value={form.address_street}
                         onChange={e => setForm(f => ({ ...f, address_street: e.target.value }))} />
                  <div className="grid grid-cols-3 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder="PLZ"
                           value={form.address_zip}
                           onChange={e => setForm(f => ({ ...f, address_zip: e.target.value }))} />
                    <input className={`${inputCls} col-span-2`} style={focusRing()} placeholder="Stadt"
                           value={form.address_city}
                           onChange={e => setForm(f => ({ ...f, address_city: e.target.value }))} />
                  </div>
                  <input className={inputCls} style={focusRing()} placeholder="Land"
                         value={form.address_country}
                         onChange={e => setForm(f => ({ ...f, address_country: e.target.value }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder="Firmen-Telefon" type="tel"
                           value={form.phone}
                           onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                    <input className={inputCls} style={focusRing()} placeholder="Firmen-E-Mail" type="email"
                           value={form.email}
                           onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                  <input className={inputCls} style={focusRing()} placeholder="Website (optional)"
                         value={form.website}
                         onChange={e => setForm(f => ({ ...f, website: e.target.value }))} />
                </div>
              </div>

              {/* Ansprechpartner */}
              <div>
                <p className="text-xs font-semibold text-gray-500 font-body mb-2 uppercase tracking-wide">Ansprechpartner</p>
                <div className="space-y-2">
                  <input className={inputCls} style={focusRing()} placeholder="Name des Ansprechpartners"
                         value={form.ansprechpartner}
                         onChange={e => setForm(f => ({ ...f, ansprechpartner: e.target.value }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder="Direkt-Telefon" type="tel"
                           value={form.ansprechpartner_phone}
                           onChange={e => setForm(f => ({ ...f, ansprechpartner_phone: e.target.value }))} />
                    <input className={inputCls} style={focusRing()} placeholder="Direkt-E-Mail" type="email"
                           value={form.ansprechpartner_email}
                           onChange={e => setForm(f => ({ ...f, ansprechpartner_email: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Interne Notizen */}
              <div>
                <label className="block text-xs text-gray-500 font-body mb-1 font-semibold">Interne Notizen</label>
                <textarea className={`${inputCls} resize-none`} style={focusRing()} rows={2}
                          placeholder="Interne Notizen…"
                          value={form.notes}
                          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>

              {formError && <p className="text-sm text-red-500 font-body">{formError}</p>}
            </div>

            <div className="px-6 pb-5 flex gap-3 justify-end border-t border-gray-100 pt-4">
              <button onClick={() => setModalOpen(false)}
                      className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 font-body hover:bg-gray-50">
                Abbrechen
              </button>
              <button onClick={handleSave} disabled={saving}
                      className="px-5 py-2 rounded-xl text-sm font-semibold text-white font-body hover:opacity-90 transition-opacity disabled:opacity-50"
                      style={{ backgroundColor: 'var(--color-highlight)' }}>
                {saving ? 'Speichern…' : editing ? '✓ Aktualisieren' : '✓ Anlegen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
             onClick={e => { if (e.target === e.currentTarget) setDeleteId(null) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
              Verwaltung löschen?
            </h2>
            <p className="text-sm text-gray-500 font-body">
              Zugewiesene Immobilien werden nicht gelöscht – nur die Zuweisung wird aufgehoben.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteId(null)}
                      className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 font-body hover:bg-gray-50">
                Abbrechen
              </button>
              <button onClick={() => handleDelete(deleteId)}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 font-body transition-colors">
                Löschen
              </button>
            </div>
          </div>
        </div>
      )}

    </DashboardLayout>
  )
}
