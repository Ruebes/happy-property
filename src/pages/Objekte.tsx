import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { useAuth } from '../lib/auth'
import { useDateFormat } from '../lib/date'

// ── Types ──────────────────────────────────────────────────────
interface Property {
  id: string
  project_name: string
  unit_number: string | null
  type: 'villa' | 'apartment' | 'studio'
  bedrooms: number
  size_sqm: number | null
  street: string | null
  house_number: string | null
  zip: string | null
  city: string | null
  description: string | null
  images: string[]
  rental_type: 'longterm' | 'shortterm'
  owner_id: string
  purchase_price_gross: number | null
  purchase_price_net: number | null
  vat_rate: number
  created_at: string
  owner: { full_name: string; email: string } | null
  is_furnished: boolean
}

interface OwnerProfile {
  id: string
  full_name: string
  email: string
}

type Step = 1 | 2 | 3 | 4

interface FormData {
  project_name: string
  unit_number: string
  type: 'villa' | 'apartment' | 'studio'
  bedrooms: string
  size_sqm: string
  is_furnished: boolean
  rental_type: 'longterm' | 'shortterm'
  purchase_price_gross: string
  vat_rate: string
  street: string
  house_number: string
  zip: string
  city: string
  description: string
  owner_id: string
}

interface OwnerModalData {
  first_name: string
  last_name: string
  email: string
  phone: string
  language: 'de' | 'en'
  tempPassword: string
  address_street: string
  address_zip: string
  address_city: string
  address_country: string
}

// ── Helpers ────────────────────────────────────────────────────
function generatePassword(): string {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower   = 'abcdefghijkmnpqrstuvwxyz'
  const digits  = '23456789'
  const special = '!@#$'
  const all = upper + lower + digits + special
  const rand = (s: string) => s[Math.floor(Math.random() * s.length)]
  const base = [rand(upper), rand(lower), rand(digits), rand(special),
    ...Array.from({ length: 8 }, () => rand(all))]
  return base.sort(() => Math.random() - 0.5).join('')
}

const EMPTY_FORM: FormData = {
  project_name: '', unit_number: '', type: 'apartment', bedrooms: '1',
  size_sqm: '', is_furnished: false, rental_type: 'longterm',
  purchase_price_gross: '', vat_rate: '19',
  street: '', house_number: '', zip: '', city: '', description: '',
  owner_id: '',
}

const EMPTY_OWNER_MODAL: OwnerModalData = {
  first_name: '', last_name: '', email: '',
  phone: '', language: 'de', tempPassword: generatePassword(),
  address_street: '', address_zip: '', address_city: '', address_country: 'Deutschland',
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-hp-black text-white text-sm
                    font-body px-5 py-3 rounded-xl shadow-lg max-w-sm">
      {message}
    </div>
  )
}

// ── Step Indicator ─────────────────────────────────────────────
function StepIndicator({ step, labels }: { step: Step; labels: string[] }) {
  return (
    <div className="flex items-center mb-6">
      {labels.map((label, i) => {
        const n = (i + 1) as Step
        const active = n === step
        const done   = n < step
        return (
          <div key={n} className="flex items-center flex-1 last:flex-none">
            <div className={`flex items-center gap-1.5 shrink-0
                            ${active ? 'opacity-100' : done ? 'opacity-75' : 'opacity-35'}`}>
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center
                            text-xs font-bold shrink-0
                            ${!active && !done ? 'bg-gray-200 text-gray-500' : 'text-white'}`}
                style={active || done ? { backgroundColor: 'var(--color-highlight)' } : {}}
              >
                {done ? '✓' : n}
              </div>
              <span className={`text-xs font-semibold font-body hidden sm:block
                               ${active ? 'text-hp-black' : 'text-gray-400'}`}>
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                className="flex-1 h-px mx-2"
                style={done ? { backgroundColor: 'var(--color-highlight)' } : { backgroundColor: '#e5e7eb' }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Label ──────────────────────────────────────────────────────
function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
}

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-hp-black text-sm font-body focus:outline-none focus:ring-2 focus:border-transparent transition'
const focusRing = () => ({ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties)

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════
export default function Objekte() {
  const { t }             = useTranslation()
  const { profile }       = useAuth()
  const { fmtCurrency }   = useDateFormat()
  const navigate          = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // List
  const [properties, setProperties]   = useState<Property[]>([])
  const [loadingList, setLoadingList] = useState(true)

  // Form
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState<string | null>(null)
  const [step, setStep]           = useState<Step>(1)
  const [form, setForm]           = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)

  // Images
  const [pendingFiles, setPendingFiles]         = useState<File[]>([])
  const [pendingPreviews, setPendingPreviews]   = useState<string[]>([])
  const [existingImages, setExistingImages]     = useState<string[]>([])
  const [uploadingImages, setUploadingImages]   = useState(false)
  const [dragOver, setDragOver]                 = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Owners
  const [owners, setOwners]               = useState<OwnerProfile[]>([])
  const [loadingOwners, setLoadingOwners] = useState(false)

  // Owner modal
  const [showOwnerModal, setShowOwnerModal]         = useState(false)
  const [ownerModal, setOwnerModal]                 = useState<OwnerModalData>(EMPTY_OWNER_MODAL)
  const [ownerModalSaving, setOwnerModalSaving]     = useState(false)
  const [ownerModalError, setOwnerModalError]       = useState('')
  const [ownerModalSuccess, setOwnerModalSuccess]   = useState(false)
  const [pwCopied, setPwCopied]                     = useState(false)

  // Toast
  const [toast, setToast] = useState('')

  const canEdit = profile?.role === 'admin' || profile?.role === 'verwalter'

  // ── Kaufpreis live ─────────────────────────────────────────
  const priceNet = useMemo(() => {
    const gross = parseFloat(form.purchase_price_gross.replace(',', '.'))
    const vat   = parseFloat(form.vat_rate.replace(',', '.'))
    if (!isNaN(gross) && gross > 0 && !isNaN(vat) && vat >= 0)
      return gross / (1 + vat / 100)
    return null
  }, [form.purchase_price_gross, form.vat_rate])

  // ── Fetch ──────────────────────────────────────────────────
  const fetchProperties = useCallback(async () => {
    setLoadingList(true)
    const { data } = await supabase
      .from('properties')
      .select('*, owner:owner_id(full_name, email)')
      .order('created_at', { ascending: false })
    setProperties((data as Property[]) ?? [])
    setLoadingList(false)
  }, [])

  useEffect(() => { fetchProperties() }, [fetchProperties])

  // Auto-open edit form when navigated here with ?edit=<id>
  useEffect(() => {
    const editParam = searchParams.get('edit')
    if (!editParam || properties.length === 0) return
    const target = properties.find(p => p.id === editParam)
    if (target) {
      openEdit(target)
      setSearchParams({}, { replace: true })
    }
  // openEdit is stable (no deps), properties changes when data loads
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, properties])

  const fetchOwners = useCallback(async () => {
    setLoadingOwners(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('role', 'eigentuemer')
      .order('full_name')
    setOwners((data as OwnerProfile[]) ?? [])
    setLoadingOwners(false)
  }, [])

  // ── Image helpers ──────────────────────────────────────────
  function addFiles(files: File[]) {
    const valid = files.filter(f =>
      f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024
    )
    const previews = valid.map(f => URL.createObjectURL(f))
    setPendingFiles(prev => [...prev, ...valid])
    setPendingPreviews(prev => [...prev, ...previews])
  }

  function removePending(idx: number) {
    URL.revokeObjectURL(pendingPreviews[idx])
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
    setPendingPreviews(prev => prev.filter((_, i) => i !== idx))
  }

  function removeExisting(idx: number) {
    setExistingImages(prev => prev.filter((_, i) => i !== idx))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    addFiles(files)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      addFiles(Array.from(e.target.files))
      e.target.value = ''
    }
  }

  async function uploadPendingImages(propertyId: string): Promise<string[]> {
    // Upload all files in parallel; random suffix prevents path collisions
    const results = await Promise.all(
      pendingFiles.map(async (file) => {
        const rand = Math.random().toString(36).slice(2, 8)
        const path = `${propertyId}/${Date.now()}-${rand}-${sanitizeFilename(file.name)}`
        const { error } = await supabase.storage
          .from('property-images')
          .upload(path, file, { upsert: true })
        if (error) return null
        const { data: pub } = supabase.storage
          .from('property-images')
          .getPublicUrl(path)
        return pub.publicUrl
      })
    )
    return results.filter((u): u is string => u !== null)
  }

  // ── Open / close form ─────────────────────────────────────
  function openAdd() {
    setEditId(null)
    setForm(EMPTY_FORM)
    setPendingFiles([])
    setPendingPreviews([])
    setExistingImages([])
    setStep(1)
    setShowForm(true)
    fetchOwners()
  }

  function openEdit(p: Property) {
    setEditId(p.id)
    setForm({
      project_name:         p.project_name,
      unit_number:          p.unit_number ?? '',
      type:                 p.type,
      bedrooms:             String(p.bedrooms),
      size_sqm:             p.size_sqm != null ? String(p.size_sqm) : '',
      is_furnished:         p.is_furnished ?? false,
      rental_type:          p.rental_type,
      purchase_price_gross: p.purchase_price_gross != null ? String(p.purchase_price_gross) : '',
      vat_rate:             p.vat_rate != null ? String(p.vat_rate) : '19',
      street:               p.street ?? '',
      house_number:         p.house_number ?? '',
      zip:                  p.zip ?? '',
      city:                 p.city ?? '',
      description:          p.description ?? '',
      owner_id:             p.owner_id,
    })
    setPendingFiles([])
    setPendingPreviews([])
    setExistingImages(p.images ?? [])
    setStep(1)
    setShowForm(true)
    fetchOwners()
  }

  function closeForm() {
    pendingPreviews.forEach(u => URL.revokeObjectURL(u))
    setPendingFiles([])
    setPendingPreviews([])
    setExistingImages([])
    setShowForm(false)
    setEditId(null)
    setStep(1)
  }

  function setField<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  // ── Validation ────────────────────────────────────────────
  const step1Valid = () => form.project_name.trim() !== ''
  const step4Valid = () => form.owner_id !== ''

  // ── Save ─────────────────────────────────────────────────
  async function handleSave() {
    if (!profile) return
    setSaving(true)
    setUploadingImages(pendingFiles.length > 0)

    try {
      const basePayload = {
        project_name:         form.project_name.trim(),
        unit_number:          form.unit_number.trim() || null,
        type:                 form.type,
        bedrooms:             parseInt(form.bedrooms) || 0,
        size_sqm:             form.size_sqm ? parseFloat(form.size_sqm.replace(',', '.')) : null,
        is_furnished:         form.is_furnished,
        rental_type:          form.rental_type,
        purchase_price_gross: form.purchase_price_gross
                                ? parseFloat(form.purchase_price_gross.replace(',', '.'))
                                : null,
        vat_rate:             parseFloat(form.vat_rate.replace(',', '.')) || 19,
        purchase_price_net:   priceNet,
        street:               form.street.trim() || null,
        house_number:         form.house_number.trim() || null,
        zip:                  form.zip.trim() || null,
        city:                 form.city.trim() || null,
        description:          form.description.trim() || null,
        owner_id:             form.owner_id,
      }

      if (editId) {
        // Upload new images first, then do a SINGLE update (data + images together)
        let finalImages = [...existingImages]
        if (pendingFiles.length > 0) {
          const newUrls = await uploadPendingImages(editId)
          finalImages = [...finalImages, ...newUrls]
        }
        const { error } = await supabase
          .from('properties')
          .update({ ...basePayload, images: finalImages })
          .eq('id', editId)
        if (error) throw error

      } else {
        // Generate UUID client-side → upload images → SINGLE insert with all data
        const newId = crypto.randomUUID()
        let images: string[] = []
        if (pendingFiles.length > 0) {
          images = await uploadPendingImages(newId)
        }
        const { error } = await supabase
          .from('properties')
          .insert({ id: newId, ...basePayload, created_by: profile.id, images })
        if (error) throw error
      }

      closeForm()
      setToast(t('success.saved'))
      fetchProperties()

    } catch {
      setToast(t('errors.saveFailed'))
    } finally {
      // Always reset spinners — even if an error occurred
      setSaving(false)
      setUploadingImages(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────
  async function handleDelete(id: string) {
    if (!window.confirm(t('properties.deleteConfirm'))) return
    await supabase.from('properties').delete().eq('id', id)
    setToast(t('success.deleted'))
    fetchProperties()
  }

  // ── Owner modal ───────────────────────────────────────────
  function openOwnerModal() {
    setOwnerModal({ ...EMPTY_OWNER_MODAL, tempPassword: generatePassword() })
    setOwnerModalError('')
    setOwnerModalSuccess(false)
    setPwCopied(false)
    setShowOwnerModal(true)
  }

  async function handleCreateOwner() {
    if (!ownerModal.first_name.trim() || !ownerModal.last_name.trim() || !ownerModal.email.trim()) return
    setOwnerModalSaving(true)
    setOwnerModalError('')

    const full_name = `${ownerModal.first_name.trim()} ${ownerModal.last_name.trim()}`
    // inviteUserByEmail → Supabase versendet automatisch die gebrandete Einladungs-E-Mail
    const { data: userData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      ownerModal.email.trim().toLowerCase(),
      {
        data: { full_name, needs_password_setup: true },
        redirectTo: `${window.location.origin}/login`,
      }
    )

    if (authError) {
      setOwnerModalError(
        authError.message.includes('already') || authError.message.includes('exists')
          ? t('properties.ownerModal.errorExists')
          : authError.message
      )
      setOwnerModalSaving(false)
      return
    }

    if (userData.user) {
      await supabaseAdmin.from('profiles').upsert({
        id: userData.user.id,
        email: ownerModal.email.trim().toLowerCase(),
        full_name,
        phone: ownerModal.phone.trim() || null,
        role: 'eigentuemer',
        language: ownerModal.language,
        address_street:  ownerModal.address_street.trim()  || null,
        address_zip:     ownerModal.address_zip.trim()     || null,
        address_city:    ownerModal.address_city.trim()    || null,
        address_country: ownerModal.address_country.trim() || null,
      })
      setOwnerModalSuccess(true)
      setOwnerModalSaving(false)
      await fetchOwners()
      setField('owner_id', userData.user.id)
      setTimeout(() => { setShowOwnerModal(false); setOwnerModalSuccess(false) }, 2000)
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(ownerModal.tempPassword)
      setPwCopied(true)
      setTimeout(() => setPwCopied(false), 2000)
    } catch { /* ignore */ }
  }

  // ── Display helpers ───────────────────────────────────────
  function locationStr(p: Property) {
    const street = [p.street, p.house_number].filter(Boolean).join(' ')
    const city   = [p.zip, p.city].filter(Boolean).join(' ')
    return [street, city].filter(Boolean).join(', ') || t('common.na')
  }

  // ════════════════════════════════════════════════════════
  // STEP RENDERERS
  // ════════════════════════════════════════════════════════

  function renderStep1() {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label required>{t('properties.projectName')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.project_name}
              onChange={e => setField('project_name', e.target.value)}
              placeholder="z. B. Palmera Villas" />
          </div>
          <div>
            <Label>{t('properties.unitNumber')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.unit_number}
              onChange={e => setField('unit_number', e.target.value)}
              placeholder="z. B. A-204" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label required>{t('properties.type')}</Label>
            <select className={inputCls} style={focusRing()}
              value={form.type}
              onChange={e => setField('type', e.target.value as FormData['type'])}>
              {(['villa', 'apartment', 'studio'] as const).map(v => (
                <option key={v} value={v}>{t(`properties.types.${v}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>{t('properties.bedrooms')}</Label>
            <select className={inputCls} style={focusRing()}
              value={form.bedrooms}
              onChange={e => setField('bedrooms', e.target.value)}>
              <option value="0">{t('properties.bedroomsStudio')}</option>
              {[1, 2, 3, 4, 5].map(n => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('properties.size')}</Label>
            <input type="number" min="0" step="0.01"
              className={inputCls} style={focusRing()}
              value={form.size_sqm}
              onChange={e => setField('size_sqm', e.target.value)}
              placeholder="85.50" />
          </div>
          <div>
            <Label>{t('properties.furnished')}</Label>
            <button type="button"
              onClick={() => setField('is_furnished', !form.is_furnished)}
              className={`w-full px-3 py-2 rounded-xl border text-sm font-body text-left
                         flex items-center gap-2 transition-colors
                         ${form.is_furnished
                           ? 'border-hp-highlight bg-orange-50 text-hp-highlight'
                           : 'border-gray-200 bg-white text-gray-500'}`}>
              <span>🛋️</span>
              <span>{form.is_furnished ? t('properties.furnishedYes') : t('properties.furnishedNo')}</span>
            </button>
          </div>
        </div>

        <div>
          <Label required>{t('properties.rentalType')}</Label>
          <select className={inputCls} style={focusRing()}
            value={form.rental_type}
            onChange={e => setField('rental_type', e.target.value as FormData['rental_type'])}>
            {(['longterm', 'shortterm'] as const).map(v => (
              <option key={v} value={v}>{t(`properties.rental.${v}`)}</option>
            ))}
          </select>
        </div>

        {/* Kaufpreis-Block */}
        <div className="border border-gray-100 rounded-xl p-4 bg-gray-50 space-y-3">
          <h4 className="text-sm font-semibold font-body text-hp-black">
            {t('properties.purchasePrice.title')}
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('properties.purchasePrice.gross')}</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">€</span>
                <input type="number" min="0" step="0.01"
                  className={`${inputCls} pl-7`} style={focusRing()}
                  value={form.purchase_price_gross}
                  onChange={e => setField('purchase_price_gross', e.target.value)}
                  placeholder="595000" />
              </div>
            </div>
            <div>
              <Label>{t('properties.purchasePrice.vat')}</Label>
              <div className="relative">
                <input type="number" min="0" max="100" step="0.01"
                  className={`${inputCls} pr-7`} style={focusRing()}
                  value={form.vat_rate}
                  onChange={e => setField('vat_rate', e.target.value)} />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">%</span>
              </div>
            </div>
          </div>
          <div>
            <Label>{t('properties.purchasePrice.net')}</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">€</span>
              <input readOnly
                className={`${inputCls} pl-7 bg-gray-100 text-gray-500 cursor-default`}
                value={priceNet != null ? fmtCurrency(priceNet).replace(/[€$£\s]/g, '') : ''}
                placeholder={t('properties.purchasePrice.netHint')} />
            </div>
            {priceNet != null && form.purchase_price_gross && (
              <p className="text-xs text-gray-400 font-body mt-1">
                {fmtCurrency(parseFloat(form.purchase_price_gross.replace(',', '.')))}
                {' ÷ (1 + '}{form.vat_rate}{'%) = '}
                <strong className="text-gray-500">{fmtCurrency(priceNet)}</strong>
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  function renderStep2() {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Label>{t('properties.street')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.street}
              onChange={e => setField('street', e.target.value)}
              placeholder="Hauptstraße" />
          </div>
          <div>
            <Label>{t('properties.houseNumber')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.house_number}
              onChange={e => setField('house_number', e.target.value)}
              placeholder="12a" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('properties.zip')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.zip}
              onChange={e => setField('zip', e.target.value)}
              placeholder="29670" />
          </div>
          <div>
            <Label>{t('properties.city')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.city}
              onChange={e => setField('city', e.target.value)}
              placeholder="Marbella" />
          </div>
        </div>
        <div>
          <Label>{t('properties.description')}</Label>
          <textarea rows={4}
            className={`${inputCls} resize-none`} style={focusRing()}
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            placeholder="Kurze Beschreibung des Objekts …" />
        </div>
      </div>
    )
  }

  function renderStep3() {
    const totalImages = existingImages.length + pendingPreviews.length
    return (
      <div className="space-y-4">
        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={e => {
            // Only reset when cursor truly leaves the zone (not just a child element)
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
          }}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-2xl p-8 text-center
                      cursor-pointer transition-all
                      ${dragOver
                        ? 'border-hp-highlight bg-orange-50'
                        : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={handleFileInput}
          />
          <div className="text-3xl mb-2">{dragOver ? '📂' : '🖼️'}</div>
          <p className="text-sm font-semibold font-body text-gray-600">
            {dragOver
              ? t('properties.imageUpload.dropzoneActive')
              : t('properties.imageUpload.dropzone')}
          </p>
          <p className="text-xs text-gray-400 font-body mt-1">
            {t('properties.imageUpload.hint')}
          </p>
          {totalImages > 0 && (
            <span className="absolute top-3 right-3 text-xs font-semibold font-body px-2 py-1
                             rounded-full text-white"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
              {t('properties.imageUpload.count_other', { count: totalImages })}
            </span>
          )}
        </div>

        {/* Image grid */}
        {(existingImages.length > 0 || pendingPreviews.length > 0) && (
          <div className="grid grid-cols-3 gap-3">
            {/* Existing (saved) images */}
            {existingImages.map((url, idx) => (
              <div key={`ex-${idx}`} className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100">
                <img src={url} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all" />
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); removeExisting(idx) }}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white
                             text-xs font-bold flex items-center justify-center
                             opacity-0 group-hover:opacity-100 transition-opacity shadow"
                >
                  ✕
                </button>
              </div>
            ))}
            {/* Pending (not yet uploaded) */}
            {pendingPreviews.map((url, idx) => (
              <div key={`new-${idx}`} className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 ring-2"
                   style={{ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties}>
                <img src={url} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all" />
                {/* "new" badge */}
                <span className="absolute bottom-1.5 left-1.5 text-[10px] font-bold px-1.5 py-0.5
                                 rounded-full bg-white text-gray-600 shadow opacity-90">
                  neu
                </span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); removePending(idx) }}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white
                             text-xs font-bold flex items-center justify-center
                             opacity-0 group-hover:opacity-100 transition-opacity shadow"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {uploadingImages && (
          <div className="flex items-center gap-2 text-sm font-body text-gray-500">
            <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin shrink-0" />
            {t('properties.imageUpload.uploading')}
          </div>
        )}
      </div>
    )
  }

  function renderStep4() {
    return (
      <div className="space-y-4">
        <div>
          <Label required>{t('properties.owner')}</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              {loadingOwners ? (
                <div className={`${inputCls} flex items-center gap-2 text-gray-400`}>
                  <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
                  {t('common.loading')}
                </div>
              ) : (
                <select className={inputCls} style={focusRing()}
                  value={form.owner_id}
                  onChange={e => setField('owner_id', e.target.value)}>
                  <option value="">{t('properties.ownerSelect')}</option>
                  {owners.length === 0 && (
                    <option disabled value="">{t('properties.ownerNone')}</option>
                  )}
                  {owners.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.full_name || o.email}{o.full_name ? ` (${o.email})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {canEdit && (
              <button type="button" onClick={openOwnerModal}
                title={t('properties.ownerModal.title')}
                className="w-10 h-10 rounded-xl border-2 flex items-center justify-center
                           text-xl font-bold transition-colors shrink-0"
                style={{ borderColor: 'var(--color-highlight)', color: 'var(--color-highlight)' }}>
                +
              </button>
            )}
          </div>

          {form.owner_id && (() => {
            const o = owners.find(o => o.id === form.owner_id)
            return o ? (
              <div className="mt-2 flex items-center gap-2 text-sm font-body
                              bg-green-50 border border-green-100 rounded-xl px-4 py-2">
                <span className="text-green-600 text-base">✓</span>
                <span className="text-gray-700 font-medium">{o.full_name}</span>
                <span className="text-gray-300">·</span>
                <span className="text-gray-400 text-xs">{o.email}</span>
              </div>
            ) : null
          })()}
        </div>
      </div>
    )
  }

  // ── Owner creation sub-modal ─────────────────────────────
  function renderOwnerModal() {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
           style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6"
             onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-lg font-bold font-body text-hp-black">
              {t('properties.ownerModal.title')}
            </h3>
            <button onClick={() => setShowOwnerModal(false)}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
          </div>

          {ownerModalSuccess ? (
            <div className="text-center py-8">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-sm font-body text-gray-600">{t('properties.ownerModal.success')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>{t('properties.ownerModal.firstName')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.first_name}
                    onChange={e => setOwnerModal(m => ({ ...m, first_name: e.target.value }))}
                    placeholder="Max" />
                </div>
                <div>
                  <Label required>{t('properties.ownerModal.lastName')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.last_name}
                    onChange={e => setOwnerModal(m => ({ ...m, last_name: e.target.value }))}
                    placeholder="Mustermann" />
                </div>
              </div>

              <div>
                <Label required>{t('profile.email')}</Label>
                <input type="email" className={inputCls} style={focusRing()}
                  value={ownerModal.email}
                  onChange={e => setOwnerModal(m => ({ ...m, email: e.target.value }))}
                  placeholder="max@beispiel.de" />
              </div>

              <div>
                <Label>{t('profile.phone')}</Label>
                <input type="tel" className={inputCls} style={focusRing()}
                  value={ownerModal.phone}
                  onChange={e => setOwnerModal(m => ({ ...m, phone: e.target.value }))}
                  placeholder="+49 170 1234567" />
              </div>

              <div>
                <Label>{t('profile.language')}</Label>
                <select className={inputCls} style={focusRing()}
                  value={ownerModal.language}
                  onChange={e => setOwnerModal(m => ({ ...m, language: e.target.value as 'de' | 'en' }))}>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div>
                <Label>{t('properties.ownerModal.addressStreet')}</Label>
                <input className={inputCls} style={focusRing()}
                  value={ownerModal.address_street}
                  onChange={e => setOwnerModal(m => ({ ...m, address_street: e.target.value }))}
                  placeholder="Hauptstraße 12a" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>{t('properties.ownerModal.addressZip')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.address_zip}
                    onChange={e => setOwnerModal(m => ({ ...m, address_zip: e.target.value }))}
                    placeholder="80331" />
                </div>
                <div className="col-span-2">
                  <Label>{t('properties.ownerModal.addressCity')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.address_city}
                    onChange={e => setOwnerModal(m => ({ ...m, address_city: e.target.value }))}
                    placeholder="München" />
                </div>
              </div>
              <div>
                <Label>{t('properties.ownerModal.addressCountry')}</Label>
                <input className={inputCls} style={focusRing()}
                  value={ownerModal.address_country}
                  onChange={e => setOwnerModal(m => ({ ...m, address_country: e.target.value }))}
                  placeholder="Deutschland" />
              </div>

              <div>
                <Label>{t('properties.ownerModal.tempPw')}</Label>
                <div className="flex gap-2">
                  <input readOnly
                    className={`${inputCls} flex-1 font-mono text-xs bg-gray-50`}
                    value={ownerModal.tempPassword} />
                  <button type="button" onClick={copyPassword}
                    className="px-3 py-2 rounded-xl border text-xs font-semibold font-body
                               transition-colors shrink-0"
                    style={pwCopied
                      ? { backgroundColor: 'var(--color-highlight)', borderColor: 'var(--color-highlight)', color: 'white' }
                      : { borderColor: 'var(--color-highlight)', color: 'var(--color-highlight)' }}>
                    {pwCopied ? '✓' : t('properties.ownerModal.copyPw')}
                  </button>
                </div>
              </div>

              {ownerModalError && (
                <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-lg">
                  {ownerModalError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowOwnerModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm
                             font-semibold font-body text-gray-600 hover:border-gray-300 transition-colors">
                  {t('common.cancel')}
                </button>
                <button type="button" onClick={handleCreateOwner}
                  disabled={ownerModalSaving || !ownerModal.first_name || !ownerModal.last_name || !ownerModal.email}
                  className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                             font-body hover:opacity-90 disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {ownerModalSaving ? t('properties.ownerModal.submitting') : t('properties.ownerModal.submit')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════
  const stepLabels = [
    t('properties.form.step1'),
    t('properties.form.step2'),
    t('properties.form.step3'),
    t('properties.form.step4'),
  ]

  return (
    <DashboardLayout basePath={`/${profile?.role ?? 'eigentuemer'}/dashboard`}>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-hp-black"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {t('properties.title')}
        </h1>
        {canEdit && (
          <button onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white
                       text-sm font-semibold font-body hover:opacity-90 transition-opacity"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            <span className="text-lg leading-none">+</span>
            {t('properties.add')}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {loadingList ? (
          <div className="flex items-center justify-center py-16 text-gray-400 font-body text-sm gap-2">
            <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : properties.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 font-body">
            <div className="text-4xl mb-3">🏠</div>
            <p className="text-sm">{t('properties.empty')}</p>
            {canEdit && (
              <button onClick={openAdd}
                className="mt-4 text-sm font-semibold underline"
                style={{ color: 'var(--color-highlight)' }}>
                {t('properties.add')}
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['name', 'type', 'location', 'rentalType', 'owner', 'actions'].map(col => (
                    <th key={col} className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      {t(`properties.columns.${col}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {properties.map((p, i) => (
                  <tr key={p.id}
                      className={`hover:bg-gray-50 transition-colors
                        ${i < properties.length - 1 ? 'border-b border-gray-50' : ''}`}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        {/* Thumbnail */}
                        {p.images?.[0] ? (
                          <img src={p.images[0]} alt=""
                            className="w-10 h-10 rounded-lg object-cover shrink-0 bg-gray-100" />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-lg">
                            🏠
                          </div>
                        )}
                        <div>
                          <button
                            type="button"
                            onClick={() => navigate(`/${profile?.role}/properties/${p.id}`)}
                            className="font-semibold text-hp-black hover:underline text-left
                                       decoration-hp-highlight underline-offset-2 transition-colors
                                       hover:text-hp-highlight"
                          >
                            {p.project_name}
                          </button>
                          {p.unit_number && (
                            <div className="text-xs text-gray-400">{p.unit_number}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-gray-600">
                      {t(`properties.types.${p.type}`)}
                    </td>
                    <td className="px-5 py-3.5 text-gray-600 max-w-[180px] truncate">
                      {locationStr(p)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full
                        ${p.rental_type === 'longterm'
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-orange-50 text-orange-700'}`}>
                        {t(`properties.rental.${p.rental_type}`)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-gray-600">
                      {p.owner?.full_name || p.owner?.email || t('common.na')}
                    </td>
                    <td className="px-5 py-3.5">
                      {canEdit && (
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEdit(p)}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg
                                       border border-gray-200 text-gray-600
                                       hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                            {t('common.edit')}
                          </button>
                          <button onClick={() => handleDelete(p.id)}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg
                                       border border-red-100 text-red-400
                                       hover:border-red-300 hover:text-red-600 transition-colors">
                            {t('common.delete')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-40 flex items-start justify-center p-4 pt-10 overflow-y-auto"
             style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
             onClick={closeForm}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-7 my-4"
               onClick={e => e.stopPropagation()}>

            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-hp-black"
                  style={{ fontFamily: 'var(--font-heading)' }}>
                {editId ? t('properties.edit') : t('properties.add')}
              </h2>
              <button onClick={closeForm} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <StepIndicator step={step} labels={stepLabels} />

            {step === 1 && renderStep1()}
            {step === 2 && renderStep2()}
            {step === 3 && renderStep3()}
            {step === 4 && renderStep4()}

            {/* Navigation */}
            <div className="flex gap-3 mt-6">
              {step > 1 && (
                <button type="button"
                  onClick={() => setStep(s => (s - 1) as Step)}
                  className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm
                             font-semibold font-body text-gray-600 hover:border-gray-300 transition-colors">
                  {t('common.back')}
                </button>
              )}
              <div className="flex-1" />
              {step < 4 ? (
                <button type="button"
                  onClick={() => setStep(s => (s + 1) as Step)}
                  disabled={step === 1 && !step1Valid()}
                  className="px-6 py-2.5 rounded-xl text-white text-sm font-semibold
                             font-body hover:opacity-90 disabled:opacity-40 transition-opacity"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {t('common.next')}
                </button>
              ) : (
                <button type="button" onClick={handleSave}
                  disabled={saving || !step4Valid()}
                  className="px-6 py-2.5 rounded-xl text-white text-sm font-semibold
                             font-body hover:opacity-90 disabled:opacity-40 transition-opacity flex items-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {(saving || uploadingImages) && (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {saving
                    ? (uploadingImages
                        ? t('properties.imageUpload.uploading')
                        : t('properties.form.saving'))
                    : t('properties.form.save')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showOwnerModal && renderOwnerModal()}
      {toast && <Toast message={toast} onClose={() => setToast('')} />}

    </DashboardLayout>
  )
}
