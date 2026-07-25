import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { CustomSelect } from '../../../../components/CustomSelect'
import { supabase } from '../../../../lib/supabase'

// ── Persönliche Buchungslinks ───────────────────────────────────────────────────
// Pro Person ein personalisierter Link auf Svens Kalender (/buchen/sven360?g=<token>)
// mit Foto + vorausgefüllten Kontaktdaten. Buchung → Termin + Bestätigung per Mail
// (von Lotte, mit Office-Bild) UND WhatsApp; Erinnerungen wie bei jedem Termin.
// Datenquelle: booking_invites (Burkhard/Giona bestehen bereits).

const BOOKING_BASE = 'https://portal.happy-property.com/buchen/sven360?g='
const PHOTO_BUCKET = 'crm-project-images'

interface Invite {
  id: string
  token: string
  slug: string
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  subject: string | null
  image_url: string | null
  image_focus: string | null
  lang: 'de' | 'en'
  internal: boolean
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

// ── Anlegen / Bearbeiten ────────────────────────────────────────────────────────
function EditModal({ invite, existingTokens, onClose, onSaved }: {
  invite: Invite | null
  existingTokens: string[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const { t } = useTranslation()
  const isNew = !invite
  const [name, setName]   = useState(invite?.guest_name ?? '')
  const [email, setEmail] = useState(invite?.guest_email ?? '')
  const [phone, setPhone] = useState(invite?.guest_phone ?? '')
  const [subject, setSubject] = useState(invite?.subject ?? '')
  const [lang, setLang]   = useState<'de' | 'en'>(invite?.lang ?? 'de')
  const [focus, setFocus] = useState(invite?.image_focus ?? 'center 25%')
  const [internal, setInternal] = useState(invite?.internal ?? false)
  const [imageUrl, setImageUrl] = useState<string | null>(invite?.image_url ?? null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'

  const uploadPhoto = async (file: File) => {
    setUploading(true); setErr('')
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `booking/${slugify(name) || 'host'}-${Date.now()}.${ext}`
      const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type, upsert: true })
      if (error) throw error
      const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path)
      setImageUrl(data.publicUrl)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('crm.booking.uploadErr', 'Foto-Upload fehlgeschlagen'))
    } finally { setUploading(false) }
  }

  const save = async () => {
    if (!name.trim()) { setErr(t('crm.booking.errName', 'Bitte einen Namen angeben.')); return }
    if (!email.trim() && !phone.trim()) { setErr(t('crm.booking.errContact', 'E-Mail oder Telefon nötig.')); return }
    setSaving(true); setErr('')
    try {
      const row = {
        slug: 'sven360',
        guest_name: name.trim(),
        guest_email: email.trim() || null,
        guest_phone: phone.trim() || null,
        subject: subject.trim() || null,
        image_url: imageUrl,
        image_focus: focus,
        lang,
        internal,
      }
      if (isNew) {
        // Token eindeutig aus dem Namen ableiten
        let base = slugify(name) || 'gast'
        let token = base, n = 2
        while (existingTokens.includes(token)) { token = `${base}-${n++}` }
        const { error } = await supabase.from('booking_invites').insert({ ...row, token })
        if (error) throw error
      } else {
        const { error } = await supabase.from('booking_invites').update(row).eq('id', invite!.id)
        if (error) throw error
      }
      onSaved(isNew ? t('crm.booking.created', '✓ Buchungslink angelegt') : t('crm.booking.updated', '✓ Buchungslink aktualisiert'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('common.error', 'Fehler'))
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">
            {isNew ? t('crm.booking.newTitle', 'Neuer Buchungslink') : t('crm.booking.editTitle', 'Buchungslink bearbeiten')}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          {/* Foto */}
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-gray-100 overflow-hidden shrink-0 border border-gray-200">
              {imageUrl
                ? <img src={imageUrl} alt="" className="w-full h-full object-cover" style={{ objectPosition: focus }} />
                : <div className="w-full h-full flex items-center justify-center text-gray-300 text-2xl">👤</div>}
            </div>
            <div className="flex-1">
              <label className="inline-block px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50 cursor-pointer">
                {uploading ? t('crm.booking.uploading', 'Lädt…') : t('crm.booking.choosePhoto', 'Foto wählen')}
                <input type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void uploadPhoto(f) }} />
              </label>
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.booking.photoHint', 'Wird oben auf der Buchungsseite gezeigt.')}</p>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.name', 'Name')}</label>
            <input value={name} onChange={e => setName(e.target.value)} className={input} placeholder="Cornelia Nowak" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.email', 'E-Mail')}</label>
              <input value={email} onChange={e => setEmail(e.target.value)} className={input} placeholder="name@mail.de" />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.phone', 'Telefon')}</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} className={input} placeholder="+49 …" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.subject', 'Betreff (optional, vorbelegt)')}</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} className={input} placeholder={t('crm.booking.subjectPh', 'z.B. Kennenlernen')} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.lang', 'Sprache')}</label>
              <CustomSelect value={lang} onChange={v => setLang(v as 'de' | 'en')} options={[
                { value: 'de', label: '🇩🇪 Deutsch' }, { value: 'en', label: '🇬🇧 English' },
              ]} />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">{t('crm.booking.focus', 'Bildausschnitt')}</label>
              <CustomSelect value={focus} onChange={setFocus} options={[
                { value: 'center 20%', label: t('crm.booking.focusTop', 'Gesicht oben') },
                { value: 'center 50%', label: t('crm.booking.focusMid', 'Mitte') },
                { value: 'center 75%', label: t('crm.booking.focusBottom', 'unten') },
              ]} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} className="accent-[#ff795d] w-4 h-4" />
            {t('crm.booking.internal', 'Interne Person (keine Kunden-Automatik)')}
          </label>

          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={save} disabled={saving || uploading} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {saving ? t('crm.booking.saving', 'Speichere…') : t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Übersicht ───────────────────────────────────────────────────────────────────
export default function BookingLinks() {
  const { t } = useTranslation()
  const [items, setItems] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ invite: Invite | null } | null>(null)
  const [toast, setToast] = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('booking_invites')
        .select('id, token, slug, guest_name, guest_email, guest_phone, subject, image_url, image_focus, lang, internal')
        .order('created_at', { ascending: true })
      if (error) throw error
      setItems((data as unknown as Invite[]) ?? [])
    } catch (err) {
      console.error('[BookingLinks] fetch:', err); setItems([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { fetchAll() }, [fetchAll])

  const linkOf = (token: string) => `${BOOKING_BASE}${token}`
  const copy = (token: string) => {
    navigator.clipboard?.writeText(linkOf(token)).then(
      () => showToast(t('crm.booking.copied', '✓ Link kopiert')),
      () => showToast(t('crm.booking.copyErr', 'Kopieren nicht möglich')))
  }
  const remove = async (inv: Invite) => {
    if (!window.confirm(t('crm.booking.deleteConfirm', 'Diesen Buchungslink löschen?'))) return
    const { error } = await supabase.from('booking_invites').delete().eq('id', inv.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    showToast(t('crm.booking.deleted', 'Buchungslink gelöscht')); fetchAll()
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}

      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.booking.title', 'Persönliche Buchungslinks')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.booking.subtitle', 'Pro Person ein Link auf deinen Kalender — mit Foto und vorausgefüllten Kontaktdaten. Bestätigung per Mail (von Lotte) und WhatsApp, Erinnerungen wie üblich.')}</p>
          </div>
          <button onClick={() => setEditing({ invite: null })}
            className="px-3 py-1.5 rounded-xl text-white text-sm font-medium whitespace-nowrap" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.booking.new', '+ Neuer Link')}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">{t('crm.booking.empty', 'Noch keine Buchungslinks angelegt.')}</p>
        ) : (
          <div className="space-y-2">
            {items.map(inv => (
              <div key={inv.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-full bg-gray-100 overflow-hidden shrink-0 border border-gray-200">
                    {inv.image_url
                      ? <img src={inv.image_url} alt="" className="w-full h-full object-cover" style={{ objectPosition: inv.image_focus ?? 'center 25%' }} />
                      : <div className="w-full h-full flex items-center justify-center text-gray-300 text-xl">👤</div>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 text-sm">{inv.guest_name || inv.token}</span>
                      {inv.lang === 'en' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">EN</span>}
                      {inv.internal && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{t('crm.booking.internalBadge', 'intern')}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{[inv.guest_email, inv.guest_phone].filter(Boolean).join(' · ') || '—'}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <code className="text-[11px] text-gray-500 bg-gray-50 rounded px-2 py-1 truncate max-w-[280px]">{linkOf(inv.token)}</code>
                      <button onClick={() => copy(inv.token)} className="text-xs font-medium shrink-0" style={{ color: '#ff795d' }}>{t('crm.booking.copy', 'Kopieren')}</button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setEditing({ invite: inv })} className="text-sm text-gray-500 hover:text-gray-800 font-medium">{t('common.edit', 'Bearbeiten')}</button>
                    <button onClick={() => remove(inv)} className="text-sm text-red-500 hover:text-red-700 font-medium">{t('common.delete', 'Löschen')}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <EditModal
          invite={editing.invite}
          existingTokens={items.map(i => i.token)}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); showToast(m); fetchAll() }}
        />
      )}
    </DashboardLayout>
  )
}
