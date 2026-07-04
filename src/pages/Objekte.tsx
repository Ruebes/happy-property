import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import type { CrmProjectUnit } from '../lib/crmTypes'

import { useAuth } from '../lib/auth'
import { useDateFormat } from '../lib/date'
import { CustomSelect } from '../components/CustomSelect'
import { renderPortalAccessEmail } from '../lib/welcomeEmail'

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
  bathrooms: number
  terrace_sqm: number | null
  floor: number | null
  block: string | null
  images: string[]
  rental_type: 'longterm' | 'shortterm' | null
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

type Step = 1 | 2 | 3

interface FormData {
  project_name: string
  unit_number: string
  type: 'villa' | 'apartment' | 'studio'
  bedrooms: string
  size_sqm: string
  terrace_sqm: string
  bathrooms: string
  floor: string
  block: string
  is_furnished: boolean
  rental_type: 'longterm' | 'shortterm' | ''
  purchase_price_gross: string
  purchase_price_net: string
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


const EMPTY_FORM: FormData = {
  project_name: '', unit_number: '', type: 'apartment', bedrooms: '1',
  size_sqm: '', terrace_sqm: '', bathrooms: '1', floor: '', block: '',
  is_furnished: false, rental_type: '',
  purchase_price_gross: '', purchase_price_net: '', vat_rate: '19',
  street: '', house_number: '', zip: '', city: '', description: '',
  owner_id: '',
}

const EMPTY_OWNER_MODAL: OwnerModalData = {
  first_name: '', last_name: '', email: '',
  phone: '', language: 'de', tempPassword: '',
  address_street: '', address_zip: '', address_city: '', address_country: 'Deutschland',
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const isError = message.startsWith('Fehler:')
  useEffect(() => {
    const t = setTimeout(onClose, isError ? 12000 : 4000)
    return () => clearTimeout(t)
  }, [onClose, isError])
  return (
    <div
      onClick={onClose}
      className={`fixed bottom-6 right-6 z-50 text-white text-sm cursor-pointer
                  font-body px-5 py-3 rounded-xl shadow-lg max-w-sm break-words`}
      style={{ backgroundColor: isError ? '#dc2626' : '#111827' }}
    >
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
  const [saveError, setSaveError] = useState('')

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
  // CRM-Verknüpfung
  const [crmProjects, setCrmProjects]       = useState<{ id: string; name: string; location: string | null }[]>([])
  const [crmProjId, setCrmProjId]           = useState('')
  const [crmUnits, setCrmUnits]             = useState<CrmProjectUnit[]>([])
  const [crmUnitId, setCrmUnitId]           = useState('')
  const [loadingCrmUnits, setLoadingCrmUnits] = useState(false)

  // Toast
  const [toast, setToast] = useState('')

  const canEdit = profile?.role === 'admin' || profile?.role === 'verwalter'

  // ── Kaufpreis bidirektional ────────────────────────────────
  function onGrossChange(val: string) {
    const gross = parseFloat(val.replace(',', '.'))
    const vat   = parseFloat(form.vat_rate.replace(',', '.'))
    const net   = (!isNaN(gross) && gross > 0 && !isNaN(vat) && vat >= 0)
      ? String(Math.round(gross / (1 + vat / 100) * 100) / 100)
      : ''
    setForm(f => ({ ...f, purchase_price_gross: val, purchase_price_net: net }))
  }

  function onNetChange(val: string) {
    const net   = parseFloat(val.replace(',', '.'))
    const vat   = parseFloat(form.vat_rate.replace(',', '.'))
    const gross = (!isNaN(net) && net > 0 && !isNaN(vat) && vat >= 0)
      ? String(Math.round(net * (1 + vat / 100) * 100) / 100)
      : ''
    setForm(f => ({ ...f, purchase_price_net: val, purchase_price_gross: gross }))
  }

  function onVatChange(val: string) {
    const vat   = parseFloat(val.replace(',', '.'))
    const gross = parseFloat(form.purchase_price_gross.replace(',', '.'))
    const net   = (!isNaN(gross) && gross > 0 && !isNaN(vat) && vat >= 0)
      ? String(Math.round(gross / (1 + vat / 100) * 100) / 100)
      : ''
    setForm(f => ({ ...f, vat_rate: val, purchase_price_net: net }))
  }

  // Für handleSave: berechneter Nettowert aus State
  const priceNet = useMemo(() => {
    const v = parseFloat(form.purchase_price_net.replace(',', '.'))
    return isNaN(v) || v <= 0 ? null : v
  }, [form.purchase_price_net])

  // ── CRM Projekte + Einheiten ───────────────────────────────
  const fetchCrmProjects = useCallback(async () => {
    const { data } = await supabase
      .from('crm_projects')
      .select('id, name, location')
      .order('name')
    setCrmProjects((data ?? []) as { id: string; name: string; location: string | null }[])
  }, [])

  async function fetchCrmUnitsForProject(projectId: string) {
    setLoadingCrmUnits(true)
    try {
      const { data } = await supabase
        .from('crm_project_units')
        .select('*')
        .eq('project_id', projectId)
        .order('block', { ascending: true, nullsFirst: true })
        .order('unit_number')
      setCrmUnits((data ?? []) as CrmProjectUnit[])
    } finally {
      setLoadingCrmUnits(false)
    }
  }

  // ── Fetch ──────────────────────────────────────────────────
  const fetchProperties = useCallback(async () => {
    setLoadingList(true)
    try {
      const { data } = await supabase
        .from('properties')
        .select(`
          id, project_name, unit_number, type,
          bedrooms, bathrooms, size_sqm, terrace_sqm, floor, block,
          street, house_number, zip, city, description,
          is_furnished, rental_type,
          purchase_price_gross, purchase_price_net, vat_rate,
          images, property_status, is_managed, management_rental_type,
          owner_id, created_by, created_at,
          owner:owner_id(full_name, email)
        `)
        .order('created_at', { ascending: false })
        .limit(500)
      setProperties((data as unknown as Property[]) ?? [])
    } catch (err) {
      console.error('[Objekte] fetchProperties:', err)
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => { fetchProperties(); fetchCrmProjects() }, [fetchProperties, fetchCrmProjects])

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
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('role', 'eigentuemer')
        .order('full_name')
      setOwners((data as OwnerProfile[]) ?? [])
    } catch (err) {
      console.error('[Objekte] fetchOwners:', err)
    } finally {
      setLoadingOwners(false)
    }
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
    setCrmProjId('')
    setCrmUnitId('')
    setCrmUnits([])
    setSaveError('')
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
      size_sqm:             p.size_sqm    != null ? String(p.size_sqm)    : '',
      terrace_sqm:          p.terrace_sqm != null ? String(p.terrace_sqm) : '',
      bathrooms:            p.bathrooms   != null ? String(p.bathrooms)   : '1',
      floor:                p.floor       != null ? String(p.floor)       : '',
      block:                p.block       ?? '',
      is_furnished:         p.is_furnished ?? false,
      rental_type:          p.rental_type ?? '',
      purchase_price_gross: p.purchase_price_gross != null ? String(p.purchase_price_gross) : '',
      purchase_price_net:   p.purchase_price_net  != null ? String(p.purchase_price_net)  : '',
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
    setSaveError('')
    setStep(1)
    setShowForm(true)
    fetchOwners()
  }

  function closeForm() {
    pendingPreviews.forEach(u => URL.revokeObjectURL(u))
    setPendingFiles([])
    setPendingPreviews([])
    setExistingImages([])
    setCrmProjId('')
    setCrmUnitId('')
    setCrmUnits([])
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
        size_sqm:             form.size_sqm    ? parseFloat(form.size_sqm.replace(',', '.'))    : null,
        terrace_sqm:          form.terrace_sqm ? parseFloat(form.terrace_sqm.replace(',', '.')) : null,
        bathrooms:            parseInt(form.bathrooms) || 1,
        floor:                form.floor ? parseInt(form.floor) : null,
        block:                form.block.trim() || null,
        is_furnished:         form.is_furnished,
        rental_type:          form.rental_type || null,
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

      let savedId = editId
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

        // Alle Spec-Felder in verknüpfte crm_project_units synchronisieren
        {
          const crmRentalType = form.rental_type === 'longterm' ? 'long'
                              : form.rental_type === 'shortterm' ? 'short'
                              : null
          await supabase
            .from('crm_project_units')
            .update({
              type:        form.type,
              bedrooms:    parseInt(form.bedrooms) || 0,
              bathrooms:   parseInt(form.bathrooms) || 1,
              size_sqm:    form.size_sqm    ? parseFloat(form.size_sqm.replace(',', '.'))    : null,
              terrace_sqm: form.terrace_sqm ? parseFloat(form.terrace_sqm.replace(',', '.')) : null,
              floor:       form.floor       ? parseInt(form.floor)                           : null,
              block:       form.block.trim() || null,
              is_furnished:form.is_furnished,
              rental_type: crmRentalType,
              price_net:   priceNet,
              price_gross: form.purchase_price_gross ? parseFloat(form.purchase_price_gross.replace(',', '.')) : null,
              vat_rate:    parseFloat(form.vat_rate.replace(',', '.')) || 19,
              unit_number: form.unit_number.trim() || null,
            })
            .eq('property_id', editId)
        }

        // Also update management_rental_type if property is managed
        await supabase
          .from('properties')
          .update({ management_rental_type: form.rental_type })
          .eq('id', editId)
          .eq('is_managed', true)

      } else {
        // Generate UUID client-side → upload images → SINGLE insert with all data
        const newId = crypto.randomUUID()
        savedId = newId
        let images: string[] = []
        if (pendingFiles.length > 0) {
          images = await uploadPendingImages(newId)
        }
        const { error } = await supabase
          .from('properties')
          .insert({ id: newId, ...basePayload, created_by: profile.id, images, property_status: 'active' })
        if (error) throw error
      }

      // CRM-Einheit verknüpfen falls ausgewählt
      if (savedId && crmProjId && crmUnitId) {
        if (crmUnitId === 'new') {
          // Neue crm_project_unit anlegen und mit property verknüpfen
          const crmRentalType = form.rental_type === 'longterm' ? 'long'
                              : form.rental_type === 'shortterm' ? 'short'
                              : null
          await supabase.from('crm_project_units').insert({
            project_id:  crmProjId,
            unit_number: form.unit_number.trim() || 'NEU',
            type:        form.type,
            bedrooms:    parseInt(form.bedrooms) || 0,
            bathrooms:   parseInt(form.bathrooms) || 1,
            size_sqm:    form.size_sqm    ? parseFloat(form.size_sqm.replace(',', '.'))    : null,
            terrace_sqm: form.terrace_sqm ? parseFloat(form.terrace_sqm.replace(',', '.')) : null,
            floor:       form.floor       ? parseInt(form.floor)                           : null,
            block:       form.block.trim() || null,
            is_furnished:form.is_furnished,
            rental_type: crmRentalType,
            price_net:   priceNet,
            price_gross: form.purchase_price_gross ? parseFloat(form.purchase_price_gross.replace(',', '.')) : null,
            vat_rate:    parseFloat(form.vat_rate.replace(',', '.')) || 19,
            property_id: savedId,
          })
        } else {
          // Bestehende Einheit mit property verknüpfen
          await supabase
            .from('crm_project_units')
            .update({ property_id: savedId })
            .eq('id', crmUnitId)
        }
      }

      closeForm()
      setToast(t('success.saved'))
      fetchProperties()

    } catch (err) {
      console.error('[handleSave] Fehler:', err)
      try {
        const e = err as Record<string, unknown>
        const msg = e?.message ?? e?.code ?? e?.details ?? JSON.stringify(err) ?? t('objekte.unknownError', 'Unbekannter Fehler')
        setSaveError(String(msg))
      } catch {
        setSaveError(t('objekte.unknownErrorNotSerializable', 'Unbekannter Fehler (nicht serialisierbar)'))
      }
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
    setOwnerModal({ ...EMPTY_OWNER_MODAL })
    setOwnerModalError('')
    setOwnerModalSuccess(false)
    setShowOwnerModal(true)
  }

  async function handleCreateOwner() {
    if (!ownerModal.first_name.trim() || !ownerModal.last_name.trim() || !ownerModal.email.trim()) return
    setOwnerModalSaving(true)
    setOwnerModalError('')

    const full_name = `${ownerModal.first_name.trim()} ${ownerModal.last_name.trim()}`
    try {
      const { data, error: fnError } = await supabase.functions.invoke('admin-user-ops', {
        body: {
          action:          'create',
          email:           ownerModal.email.trim().toLowerCase(),
          full_name,
          role:            'eigentuemer',
          language:        ownerModal.language,
          phone:           ownerModal.phone.trim()            || undefined,
          address_street:  ownerModal.address_street.trim()  || undefined,
          address_zip:     ownerModal.address_zip.trim()      || undefined,
          address_city:    ownerModal.address_city.trim()     || undefined,
          address_country: ownerModal.address_country.trim() || undefined,
        },
      })

      if (fnError || data?.error) {
        const msg = data?.error ?? fnError?.message ?? t('objekte.unknownError', 'Unbekannter Fehler')
        setOwnerModalError(
          msg.includes('already') || msg.includes('exists')
            ? t('properties.ownerModal.errorExists')
            : msg
        )
        return
      }

      // Zugangsdaten automatisch per E-Mail senden
      if (data?.password && data?.userId) {
        const email = ownerModal.email.trim().toLowerCase()
        const { subject, html } = await renderPortalAccessEmail(ownerModal.first_name.trim(), email, data.password)
        supabase.functions.invoke('send-email', {
          body: { to: email, subject, html },
        }).catch(() => {})
      }
      setOwnerModalSuccess(true)
      await fetchOwners()
      if (data?.userId) setField('owner_id', data.userId)
    } catch (err) {
      setOwnerModalError(err instanceof Error ? err.message : t('objekte.errorCreating', 'Fehler beim Anlegen'))
    } finally {
      setOwnerModalSaving(false)
    }
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

        {/* ── CRM-Projekt verknüpfen ─────────────────────────── */}
        {!editId && (
          <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide font-body">
              🔗 {t('objekte.linkCrmProject', 'CRM-Projekt verknüpfen')} <span className="font-normal normal-case">({t('objekte.optional', 'optional')})</span>
            </p>

            {/* Projekt-Dropdown */}
            <div>
              <Label>{t('objekte.projectFromCrm', 'Projekt aus CRM')}</Label>
              <CustomSelect
                className={inputCls} style={focusRing()}
                value={crmProjId}
                onChange={pid => {
                  setCrmProjId(pid)
                  setCrmUnitId('')
                  setCrmUnits([])
                  if (pid) {
                    const proj = crmProjects.find(p => p.id === pid)
                    if (proj) {
                      setField('project_name', proj.name)
                      // Standort des Projekts → Ort in Schritt 2 vorausfüllen
                      if (proj.location) setField('city', proj.location)
                    }
                    fetchCrmUnitsForProject(pid)
                  }
                }}
                options={[
                  { value: '', label: t('objekte.noCrmProject', '— Kein CRM-Projekt —') },
                  ...crmProjects.map(p => ({ value: p.id, label: p.name })),
                ]}
                placeholder={t('objekte.noCrmProject', '— Kein CRM-Projekt —')}
              />
            </div>

            {/* Einheiten-Dropdown (erscheint nach Projektauswahl) */}
            {crmProjId && (
              <div>
                <Label>{t('objekte.unitLabel', 'Wohnungseinheit')}</Label>
                {loadingCrmUnits ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-gray-400 font-body">
                    <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin shrink-0" />
                    {t('objekte.loadingUnits', 'Lade Einheiten…')}
                  </div>
                ) : (
                  <CustomSelect
                    className={inputCls} style={focusRing()}
                    value={crmUnitId}
                    onChange={uid => {
                      setCrmUnitId(uid)
                      if (uid && uid !== 'new') {
                        const unit = crmUnits.find(u => u.id === uid)
                        if (unit) {
                          setField('unit_number', unit.unit_number)
                          setField('type', unit.type as FormData['type'])
                          if (unit.bedrooms    != null) setField('bedrooms',    String(unit.bedrooms))
                          if (unit.bathrooms   != null) setField('bathrooms',   String(unit.bathrooms))
                          if (unit.size_sqm    != null) setField('size_sqm',    String(unit.size_sqm))
                          if (unit.terrace_sqm != null) setField('terrace_sqm', String(unit.terrace_sqm))
                          if (unit.floor       != null) setField('floor',       String(unit.floor))
                          if (unit.block)               setField('block',       unit.block)
                          if (unit.price_net   != null) onNetChange(String(unit.price_net))
                        }
                      }
                    }}
                    options={[
                      { value: '', label: t('objekte.selectUnit', '— Einheit auswählen —') },
                      ...crmUnits.filter(u => !u.property_id).map(u => ({
                        value: u.id,
                        label: `${u.block ? `${t('objekte.blockPrefix', 'Block {{block}}', { block: u.block })} · ` : ''}${u.unit_number}${u.type === 'villa' ? ` · ${t('objekte.villaSuffix', 'Villa')}` : u.type === 'studio' ? ` · ${t('objekte.studioSuffix', 'Studio')}` : ''}${u.bedrooms ? ` · ${t('objekte.bedroomsAbbrShort', '{{count}} SZ', { count: u.bedrooms })}` : ''}${u.size_sqm ? ` · ${u.size_sqm} m²` : ''}`,
                      })),
                      { value: 'new', label: t('objekte.addNewUnit', '+ Neue Einheit anlegen') },
                    ]}
                    placeholder={t('objekte.selectUnit', '— Einheit auswählen —')}
                  />
                )}
                {crmUnitId === 'new' && (
                  <p className="text-xs text-blue-600 font-body mt-1">
                    ℹ️ {t('objekte.newUnitHint', 'Neue Einheit wird beim Speichern automatisch im CRM angelegt – fülle unten die Details aus.')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label required>{t('properties.projectName')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.project_name}
              onChange={e => setField('project_name', e.target.value)}
              placeholder={t('objekte.projectNamePlaceholder', 'z. B. Palmera Villas')} />
          </div>
          <div>
            <Label>{t('properties.unitNumber')}</Label>
            <input className={inputCls} style={focusRing()}
              value={form.unit_number}
              onChange={e => setField('unit_number', e.target.value)}
              placeholder={t('objekte.unitNumberPlaceholder', 'z. B. A-204')} />
          </div>
        </div>

        <div>
          <Label required>{t('properties.type')}</Label>
          <CustomSelect
            className={inputCls} style={focusRing()}
            value={form.type}
            onChange={val => setField('type', val as FormData['type'])}
            options={(['villa', 'apartment', 'studio'] as const).map(v => ({
              value: v, label: t(`properties.types.${v}`),
            }))}
          />
        </div>

        {/* Flächen */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('properties.size')}</Label>
            <div className="relative">
              <input type="text" inputMode="decimal"
                className={`${inputCls} pr-10`} style={focusRing()}
                value={form.size_sqm}
                onChange={e => setField('size_sqm', e.target.value)}
                placeholder="85.50" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">m²</span>
            </div>
          </div>
          <div>
            <Label>{t('objekte.terraceSize', 'Terrasse (m²)')}</Label>
            <div className="relative">
              <input type="text" inputMode="decimal"
                className={`${inputCls} pr-10`} style={focusRing()}
                value={form.terrace_sqm}
                onChange={e => setField('terrace_sqm', e.target.value)}
                placeholder="20" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">m²</span>
            </div>
          </div>
        </div>

        {/* Zimmer & Lage */}
        <div className="grid grid-cols-4 gap-3">
          <div>
            <Label>{t('objekte.bedrooms', 'Schlafzimmer')}</Label>
            <CustomSelect
              className={inputCls} style={focusRing()}
              value={form.bedrooms}
              onChange={val => setField('bedrooms', val)}
              options={[
                { value: '0', label: t('objekte.studio', 'Studio') },
                ...[1,2,3,4,5,6].map(n => ({ value: String(n), label: String(n) })),
              ]}
            />
          </div>
          <div>
            <Label>{t('objekte.bathrooms', 'Badezimmer')}</Label>
            <CustomSelect
              className={inputCls} style={focusRing()}
              value={form.bathrooms}
              onChange={val => setField('bathrooms', val)}
              options={[1,2,3,4].map(n => ({ value: String(n), label: String(n) }))}
            />
          </div>
          <div>
            <Label>{t('objekte.floor', 'Etage')}</Label>
            <input type="text" inputMode="numeric"
              className={inputCls} style={focusRing()}
              value={form.floor}
              onChange={e => setField('floor', e.target.value)}
              placeholder="1" />
          </div>
          <div>
            <Label>{t('objekte.block', 'Block')}</Label>
            <input type="text"
              className={inputCls} style={focusRing()}
              value={form.block}
              onChange={e => setField('block', e.target.value)}
              placeholder="A" />
          </div>
        </div>

        {/* Möblierung */}
        <div className="grid grid-cols-2 gap-3">
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
          <Label>{t('properties.rentalType')}</Label>
          <CustomSelect
            className={inputCls} style={focusRing()}
            value={form.rental_type}
            onChange={val => setField('rental_type', val as FormData['rental_type'])}
            placeholder={t('objekte.rentalTypeNotSet', '— Noch nicht festgelegt —')}
            options={[
              { value: '', label: t('objekte.rentalTypeNotSet', '— Noch nicht festgelegt —') },
              { value: 'longterm',  label: t('properties.rental.longterm')  },
              { value: 'shortterm', label: t('properties.rental.shortterm') },
            ]}
          />
          <p className="text-xs text-gray-400 font-body mt-1">
            {t('objekte.rentalTypeHint', 'Wird spätestens bei Freigabe für die Verwaltung festgelegt.')}
          </p>
        </div>

        {/* Kaufpreis-Block */}
        <div className="border border-gray-100 rounded-xl p-4 bg-gray-50 space-y-3">
          <h4 className="text-sm font-semibold font-body text-hp-black">
            {t('properties.purchasePrice.title')}
          </h4>
          {/* MwSt-Zeile */}
          <div>
            <Label>{t('properties.purchasePrice.vat')}</Label>
            <div className="relative w-36">
              <input type="number" min="0" max="100" step="0.01"
                className={`${inputCls} pr-7`} style={focusRing()}
                value={form.vat_rate}
                onChange={e => onVatChange(e.target.value)} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">%</span>
            </div>
          </div>
          {/* Brutto / Netto — bidirektional */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('properties.purchasePrice.gross')}</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">€</span>
                <input
                  type="text" inputMode="decimal"
                  className={`${inputCls} pl-7`} style={focusRing()}
                  value={form.purchase_price_gross}
                  onChange={e => onGrossChange(e.target.value)}
                  placeholder="595000" />
              </div>
            </div>
            <div>
              <Label>{t('properties.purchasePrice.net')}</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">€</span>
                <input
                  type="text" inputMode="decimal"
                  className={`${inputCls} pl-7`} style={focusRing()}
                  value={form.purchase_price_net}
                  onChange={e => onNetChange(e.target.value)}
                  placeholder="500000" />
              </div>
            </div>
          </div>
          {priceNet != null && form.purchase_price_gross && (
            <p className="text-xs text-gray-400 font-body">
              {t('objekte.priceGrossSummary', '{{amount}} brutto', { amount: fmtCurrency(parseFloat(form.purchase_price_gross.replace(',', '.'))) })}
              {' · '}{t('objekte.priceVatSummary', 'MwSt {{rate}}%', { rate: form.vat_rate })}{' · '}
              <strong className="text-gray-600">{t('objekte.priceNetSummary', '{{amount}} netto', { amount: fmtCurrency(priceNet) })}</strong>
            </p>
          )}
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
                  {t('objekte.newBadge', 'neu')}
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
                <CustomSelect
                  className={inputCls} style={focusRing()}
                  value={form.owner_id}
                  onChange={val => setField('owner_id', val)}
                  options={[
                    { value: '', label: t('properties.ownerSelect') },
                    ...(owners.length === 0
                      ? [{ value: '__none__', label: t('properties.ownerNone'), disabled: true }]
                      : owners.map(o => ({
                          value: o.id,
                          label: `${o.full_name || o.email}${o.full_name ? ` (${o.email})` : ''}`,
                        }))
                    ),
                  ]}
                  placeholder={t('properties.ownerSelect')}
                />
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
              <div className="mt-2 flex items-center justify-between gap-2
                              bg-green-50 border border-green-100 rounded-xl px-4 py-2">
                <div className="flex items-center gap-2 text-sm font-body min-w-0">
                  <span className="text-green-600 text-base shrink-0">✓</span>
                  <span className="text-gray-700 font-medium truncate">{o.full_name}</span>
                  <span className="text-gray-300 shrink-0">·</span>
                  <span className="text-gray-400 text-xs truncate">{o.email}</span>
                </div>
                <a
                  href="/admin/users"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold shrink-0 px-2.5 py-1 rounded-lg
                             border border-green-200 text-green-700 hover:bg-green-100
                             transition-colors whitespace-nowrap"
                >
                  {t('objekte.goToProfile', '→ Profil')}
                </a>
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
            <div className="py-4 space-y-4">
              <div className="flex items-start gap-3 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
                <span className="text-2xl shrink-0">✉️</span>
                <div>
                  <p className="text-sm font-semibold text-green-800 font-body">{t('objekte.userCreated', 'Nutzer angelegt')}</p>
                  <p className="text-xs text-green-700 font-body mt-0.5">
                    {t('objekte.credentialsSentTo', 'Zugangsdaten wurden automatisch an {{email}} gesendet.', { email: ownerModal.email })}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setShowOwnerModal(false); setOwnerModalSuccess(false) }}
                className="w-full py-2.5 rounded-xl text-white text-sm font-semibold font-body hover:opacity-90 transition-opacity"
                style={{ backgroundColor: 'var(--color-highlight)' }}
              >
                {t('objekte.closeAndContinue', 'Schließen & weiter')}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>{t('properties.ownerModal.firstName')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.first_name}
                    onChange={e => setOwnerModal(m => ({ ...m, first_name: e.target.value }))}
                    placeholder={t('objekte.firstNamePlaceholder', 'Max')} />
                </div>
                <div>
                  <Label required>{t('properties.ownerModal.lastName')}</Label>
                  <input className={inputCls} style={focusRing()}
                    value={ownerModal.last_name}
                    onChange={e => setOwnerModal(m => ({ ...m, last_name: e.target.value }))}
                    placeholder={t('objekte.lastNamePlaceholder', 'Mustermann')} />
                </div>
              </div>

              <div>
                <Label required>{t('profile.email')}</Label>
                <input type="email" className={inputCls} style={focusRing()}
                  value={ownerModal.email}
                  onChange={e => setOwnerModal(m => ({ ...m, email: e.target.value }))}
                  placeholder={t('objekte.emailPlaceholder', 'max@beispiel.de')} />
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
                  <option value="de">{t('objekte.languageGerman', 'Deutsch')}</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div>
                <Label>{t('properties.ownerModal.addressStreet')}</Label>
                <input className={inputCls} style={focusRing()}
                  value={ownerModal.address_street}
                  onChange={e => setOwnerModal(m => ({ ...m, address_street: e.target.value }))}
                  placeholder={t('objekte.addressStreetPlaceholder', 'Hauptstraße 12a')} />
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
                    placeholder={t('objekte.addressCityPlaceholder', 'München')} />
                </div>
              </div>
              <div>
                <Label>{t('properties.ownerModal.addressCountry')}</Label>
                <input className={inputCls} style={focusRing()}
                  value={ownerModal.address_country}
                  onChange={e => setOwnerModal(m => ({ ...m, address_country: e.target.value }))}
                  placeholder={t('objekte.addressCountryPlaceholder', 'Deutschland')} />
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
                      {p.rental_type ? (
                        <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full
                          ${p.rental_type === 'longterm'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-orange-50 text-orange-700'}`}>
                          {t(`properties.rental.${p.rental_type}`)}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300 font-body">—</span>
                      )}
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
            {step === 2 && renderStep3()}
            {step === 3 && renderStep4()}

            {/* Save error display */}
            {saveError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-body break-words">
                <strong>{t('objekte.saveErrorPrefix', 'Fehler beim Speichern:')}</strong><br />{saveError}
              </div>
            )}

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
              {step < 3 ? (
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
