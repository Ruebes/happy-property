import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type {
  CrmProject, CrmProjectUnit, CrmUnitDocument, CrmUnitPayment,
  UnitType, UnitStatus,
} from '../../../lib/crmTypes'

// ── Local types ───────────────────────────────────────────────────────────────

type ModalTab = 'grunddaten' | 'zahlungen' | 'dokumente' | 'verwaltung'

interface Verwalter { id: string; full_name: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '–'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(v)
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '–'
  return new Date(d).toLocaleDateString('de-DE')
}

function calcGross(net: number, vat: number) {
  return Math.round(net * (1 + vat / 100) * 100) / 100
}
function calcNet(gross: number, vat: number) {
  return Math.round((gross / (1 + vat / 100)) * 100) / 100
}

function formatFileSize(b: number | null): string {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

const STATUS_PILL: Record<UnitStatus, string> = {
  available:          'bg-green-100 text-green-700',
  reserved:           'bg-yellow-100 text-yellow-700',
  sold:               'bg-red-100 text-red-700',
  under_construction: 'bg-blue-100 text-blue-700',
}
const STATUS_BAR: Record<UnitStatus, string> = {
  available:          '#22c55e',
  reserved:           '#eab308',
  sold:               '#ef4444',
  under_construction: '#3b82f6',
}
const STATUS_LABEL: Record<UnitStatus, string> = {
  available:          'Verfügbar',
  reserved:           'Reserviert',
  sold:               'Verkauft',
  under_construction: 'Im Bau',
}
const DOC_PILL: Record<string, string> = {
  kaufvertrag:  'bg-purple-100 text-purple-700',
  zahlungsbeleg:'bg-green-100 text-green-700',
  grundriss:    'bg-blue-100 text-blue-700',
  sonstiges:    'bg-gray-100 text-gray-600',
}
const DOC_LABEL: Record<string, string> = {
  kaufvertrag:  'Kaufvertrag',
  zahlungsbeleg:'Zahlungsbeleg',
  grundriss:    'Grundriss',
  sonstiges:    'Sonstiges',
}

// ── Empty form defaults ───────────────────────────────────────────────────────

const EMPTY_FORM = {
  block: '', unit_number: '',
  type: 'apartment' as UnitType, status: 'available' as UnitStatus,
  bedrooms: 1, bathrooms: 1,
  size_sqm: '', terrace_sqm: '', floor: '',
  price_net: '', price_gross: '', vat_rate: '5',
  is_furnished: false, handover_date: '',
  notes: '',
  // verwaltung tab
  is_completed: false, verwalter_id: '',
  rental_type: '' as 'short' | 'long' | '',
}

const EMPTY_PAY = {
  description: '', amount: '',
  due_date: '', paid_date: '',
  is_paid: false, payment_reference: '',
}

// ── UnitCard ──────────────────────────────────────────────────────────────────

function UnitCard({
  unit, onClick,
}: {
  unit: CrmProjectUnit
  onClick: () => void
}) {
  const price = unit.price_gross ?? unit.price_net
  return (
    <div
      className="bg-white rounded-2xl border border-gray-100 shadow-sm
                 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer overflow-hidden"
      onClick={onClick}
    >
      {/* Status colour bar */}
      <div
        className="h-1.5"
        style={{ backgroundColor: unit.is_completed ? '#22c55e' : STATUS_BAR[unit.status] }}
      />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between mb-2">
          <div>
            {unit.block && (
              <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                Block {unit.block} ·{' '}
              </span>
            )}
            <span className="text-base font-bold text-gray-900 font-body">{unit.unit_number}</span>
            <div className="mt-1">
              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_PILL[unit.status]}`}>
                {unit.is_completed ? '✅ Übergeben' : STATUS_LABEL[unit.status]}
              </span>
            </div>
          </div>
          {unit.rental_type && (
            <span className="text-xl" title={unit.rental_type === 'short' ? 'Kurzzeitmiete' : 'Langzeitmiete'}>
              {unit.rental_type === 'short' ? '🏖️' : '🏠'}
            </span>
          )}
        </div>

        {/* Details */}
        <div className="space-y-0.5 text-xs text-gray-500 mt-3">
          {unit.size_sqm != null && (
            <p>
              📐 {unit.size_sqm} m²
              {unit.terrace_sqm != null ? ` · ${unit.terrace_sqm} m² Terrasse` : ''}
            </p>
          )}
          {(unit.bedrooms > 0 || unit.bathrooms > 0) && (
            <p>🛏️ {unit.bedrooms} SZ · 🚿 {unit.bathrooms} Bad</p>
          )}
          {price != null && (
            <p className="font-semibold text-gray-700 mt-1">
              💶 {fmtPrice(price)}
              {unit.price_gross == null && unit.price_net != null ? ' netto' : ''}
            </p>
          )}
          {unit.handover_date && <p>📅 Übergabe {fmtDate(unit.handover_date)}</p>}
          {unit.verwalter && <p>👤 {unit.verwalter.full_name}</p>}
          {unit.is_furnished && <p>🛋️ Möbliert</p>}
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectDetail() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { profile } = useAuth()

  // ── Core data ────────────────────────────────────────────────────────────────
  const [project,    setProject]    = useState<CrmProject | null>(null)
  const [units,      setUnits]      = useState<CrmProjectUnit[]>([])
  const [verwalters, setVerwalters] = useState<Verwalter[]>([])
  const [loading,    setLoading]    = useState(true)

  // ── Modal ────────────────────────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false)
  const [editUnit,  setEditUnit]  = useState<CrmProjectUnit | null>(null)
  const [tab,       setTab]       = useState<ModalTab>('grunddaten')
  const [saving,    setSaving]    = useState(false)
  const [form,      setForm]      = useState({ ...EMPTY_FORM })

  // ── Payments ─────────────────────────────────────────────────────────────────
  const [payments,   setPayments]   = useState<CrmUnitPayment[]>([])
  const [payLoading, setPayLoading] = useState(false)
  const [payForm,    setPayForm]    = useState({ ...EMPTY_PAY })
  const [editPayId,  setEditPayId]  = useState<string | null>(null)
  const [savingPay,  setSavingPay]  = useState(false)

  // ── Documents ─────────────────────────────────────────────────────────────────
  const [documents,   setDocuments]   = useState<CrmUnitDocument[]>([])
  const [docLoading,  setDocLoading]  = useState(false)
  const [uploadingDoc,setUploadingDoc]= useState(false)
  const [docForm,     setDocForm]     = useState({
    name: '', doc_type: 'sonstiges' as CrmUnitDocument['doc_type'], notes: '',
  })
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Fetch project + units ────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [projRes, unitsRes, verwRes] = await Promise.all([
        supabase.from('crm_projects').select('*').eq('id', projectId).single(),
        supabase.from('crm_project_units')
          .select('*, verwalter:verwalter_id(id, full_name)')
          .eq('project_id', projectId)
          .order('block',       { ascending: true, nullsFirst: true })
          .order('unit_number', { ascending: true }),
        supabase.from('profiles').select('id, full_name').eq('role', 'verwalter').order('full_name'),
      ])
      if (projRes.data) setProject(projRes.data as CrmProject)
      setUnits((unitsRes.data ?? []) as CrmProjectUnit[])
      setVerwalters((verwRes.data ?? []) as Verwalter[])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Fetch payments / documents for open unit ────────────────────────────────
  const fetchPayments = useCallback(async (unitId: string) => {
    setPayLoading(true)
    try {
      const { data } = await supabase
        .from('crm_unit_payments')
        .select('*')
        .eq('unit_id', unitId)
        .order('due_date', { ascending: true, nullsFirst: true })
      setPayments((data ?? []) as CrmUnitPayment[])
    } finally { setPayLoading(false) }
  }, [])

  const fetchDocuments = useCallback(async (unitId: string) => {
    setDocLoading(true)
    try {
      const { data } = await supabase
        .from('crm_unit_documents')
        .select('*')
        .eq('unit_id', unitId)
        .order('created_at', { ascending: false })
      setDocuments((data ?? []) as CrmUnitDocument[])
    } finally { setDocLoading(false) }
  }, [])

  // ── Modal open helpers ───────────────────────────────────────────────────────
  function openNew() {
    setEditUnit(null)
    setForm({ ...EMPTY_FORM })
    setPayments([])
    setDocuments([])
    setTab('grunddaten')
    setShowModal(true)
  }

  function openEdit(unit: CrmProjectUnit) {
    setEditUnit(unit)
    setForm({
      block:        unit.block          ?? '',
      unit_number:  unit.unit_number,
      type:         unit.type,
      status:       unit.status,
      bedrooms:     unit.bedrooms,
      bathrooms:    unit.bathrooms,
      size_sqm:     unit.size_sqm?.toString()     ?? '',
      terrace_sqm:  unit.terrace_sqm?.toString()  ?? '',
      floor:        unit.floor?.toString()         ?? '',
      price_net:    unit.price_net?.toString()     ?? '',
      price_gross:  unit.price_gross?.toString()   ?? '',
      vat_rate:     (unit.vat_rate ?? 5).toString(),
      is_furnished: unit.is_furnished,
      handover_date:unit.handover_date ?? '',
      notes:        unit.notes ?? '',
      is_completed: unit.is_completed,
      verwalter_id: unit.verwalter_id ?? '',
      rental_type:  unit.rental_type  ?? '',
    })
    setTab('grunddaten')
    setShowModal(true)
    fetchPayments(unit.id)
    fetchDocuments(unit.id)
  }

  function closeModal() {
    setShowModal(false)
    setEditUnit(null)
    setPendingFile(null)
    setEditPayId(null)
    setPayForm({ ...EMPTY_PAY })
  }

  // ── Price auto-calculation ───────────────────────────────────────────────────
  function handleNetChange(val: string) {
    const net = parseFloat(val); const vat = parseFloat(form.vat_rate) || 5
    setForm(f => ({ ...f, price_net: val, price_gross: isNaN(net) ? '' : calcGross(net, vat).toString() }))
  }
  function handleGrossChange(val: string) {
    const gross = parseFloat(val); const vat = parseFloat(form.vat_rate) || 5
    setForm(f => ({ ...f, price_gross: val, price_net: isNaN(gross) ? '' : calcNet(gross, vat).toString() }))
  }
  function handleVatChange(val: string) {
    const vat = parseFloat(val) || 5; const net = parseFloat(form.price_net)
    setForm(f => ({ ...f, vat_rate: val, price_gross: isNaN(net) ? '' : calcGross(net, vat).toString() }))
  }

  // ── Save unit ────────────────────────────────────────────────────────────────
  async function handleSaveUnit() {
    if (!form.unit_number.trim() || !projectId) return
    setSaving(true)
    try {
      const payload = {
        project_id:   projectId,
        block:        form.block.trim() || null,
        unit_number:  form.unit_number.trim(),
        type:         form.type,
        status:       form.status,
        bedrooms:     form.bedrooms,
        bathrooms:    form.bathrooms,
        size_sqm:     form.size_sqm    ? parseFloat(form.size_sqm)   : null,
        terrace_sqm:  form.terrace_sqm ? parseFloat(form.terrace_sqm): null,
        floor:        form.floor       ? parseInt(form.floor)         : null,
        price_net:    form.price_net   ? parseFloat(form.price_net)   : null,
        price_gross:  form.price_gross ? parseFloat(form.price_gross) : null,
        vat_rate:     parseFloat(form.vat_rate) || 5,
        is_furnished: form.is_furnished,
        handover_date:form.handover_date || null,
        notes:        form.notes.trim() || null,
        is_completed: form.is_completed,
        verwalter_id: form.verwalter_id || null,
        rental_type:  form.rental_type  || null,
      }
      if (editUnit) {
        await supabase.from('crm_project_units').update(payload).eq('id', editUnit.id)
      } else {
        await supabase.from('crm_project_units').insert(payload)
      }
      await fetchData()
      setShowModal(false)
    } finally { setSaving(false) }
  }

  // ── Delete unit ──────────────────────────────────────────────────────────────
  async function handleDeleteUnit(id: string) {
    if (!window.confirm('Wohnung wirklich löschen? Alle Zahlungen und Dokumente werden ebenfalls gelöscht.')) return
    await supabase.from('crm_project_units').delete().eq('id', id)
    await fetchData()
    setShowModal(false)
  }

  // ── Payment CRUD ─────────────────────────────────────────────────────────────
  async function handleSavePayment() {
    if (!editUnit || !payForm.amount) return
    setSavingPay(true)
    try {
      const payload = {
        unit_id:           editUnit.id,
        project_id:        projectId,
        description:       payForm.description.trim() || null,
        amount:            parseFloat(payForm.amount),
        due_date:          payForm.due_date  || null,
        paid_date:         payForm.paid_date || null,
        is_paid:           payForm.is_paid,
        payment_reference: payForm.payment_reference.trim() || null,
      }
      if (editPayId) {
        await supabase.from('crm_unit_payments').update(payload).eq('id', editPayId)
      } else {
        await supabase.from('crm_unit_payments').insert(payload)
      }
      setPayForm({ ...EMPTY_PAY }); setEditPayId(null)
      await fetchPayments(editUnit.id)
    } finally { setSavingPay(false) }
  }

  async function handleDeletePayment(id: string) {
    if (!editUnit) return
    await supabase.from('crm_unit_payments').delete().eq('id', id)
    await fetchPayments(editUnit.id)
  }

  async function togglePaid(pay: CrmUnitPayment) {
    await supabase.from('crm_unit_payments').update({
      is_paid:   !pay.is_paid,
      paid_date: !pay.is_paid ? new Date().toISOString().slice(0, 10) : null,
    }).eq('id', pay.id)
    if (editUnit) await fetchPayments(editUnit.id)
  }

  // ── Document CRUD ────────────────────────────────────────────────────────────
  async function handleUploadDoc() {
    if (!editUnit || !pendingFile || !docForm.name.trim()) return
    setUploadingDoc(true)
    try {
      const ext  = pendingFile.name.split('.').pop() ?? 'pdf'
      const path = `unit-documents/${editUnit.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('unit-documents').upload(path, pendingFile, { upsert: false })
      if (upErr) throw upErr
      await supabase.from('crm_unit_documents').insert({
        unit_id:     editUnit.id,
        project_id:  projectId,
        name:        docForm.name.trim(),
        file_path:   path,
        file_name:   pendingFile.name,
        file_size:   pendingFile.size,
        doc_type:    docForm.doc_type,
        notes:       docForm.notes.trim() || null,
        uploaded_by: profile?.id ?? null,
      })
      setPendingFile(null)
      setDocForm({ name: '', doc_type: 'sonstiges', notes: '' })
      if (fileInputRef.current) fileInputRef.current.value = ''
      await fetchDocuments(editUnit.id)
    } catch (err) {
      console.error('[ProjectDetail] Upload error:', err)
    } finally { setUploadingDoc(false) }
  }

  async function handleDeleteDoc(doc: CrmUnitDocument) {
    if (!editUnit || !window.confirm('Dokument wirklich löschen?')) return
    await supabase.storage.from('unit-documents').remove([doc.file_path])
    await supabase.from('crm_unit_documents').delete().eq('id', doc.id)
    await fetchDocuments(editUnit.id)
  }

  async function handleOpenDoc(doc: CrmUnitDocument) {
    const { data } = await supabase.storage
      .from('unit-documents').createSignedUrl(doc.file_path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // ── Payment summary ──────────────────────────────────────────────────────────
  const totalPrice     = form.price_gross ? parseFloat(form.price_gross) : (form.price_net ? parseFloat(form.price_net) : null)
  const totalPaid      = payments.filter(p => p.is_paid).reduce((s, p) => s + p.amount, 0)
  const totalScheduled = payments.reduce((s, p) => s + p.amount, 0)
  const outstanding    = totalScheduled - totalPaid

  // ── Group units by block ─────────────────────────────────────────────────────
  const byBlock = units.reduce<Record<string, CrmProjectUnit[]>>((acc, u) => {
    const k = u.block ?? '—'; if (!acc[k]) acc[k] = []; acc[k].push(u); return acc
  }, {})
  const multiBlock = Object.keys(byBlock).length > 1

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <DashboardLayout basePath="/admin/crm">
      <div className="flex items-center justify-center h-64">
        <span className="w-8 h-8 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin inline-block" />
      </div>
    </DashboardLayout>
  )

  if (!project) return (
    <DashboardLayout basePath="/admin/crm">
      <div className="text-center py-20 text-gray-400">Projekt nicht gefunden.</div>
    </DashboardLayout>
  )

  return (
    <DashboardLayout basePath="/admin/crm">

      {/* ── Page header ── */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/admin/crm/projects')}
          className="text-sm text-gray-400 hover:text-gray-600 mb-3 inline-flex items-center gap-1"
        >
          ← Zurück zu Projekten
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 font-body">{project.name}</h1>
            {(project.developer || project.location) && (
              <p className="text-sm text-gray-400 mt-0.5">
                {[project.developer, project.location].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <button
            onClick={openNew}
            className="px-4 py-2 text-sm font-medium text-white rounded-xl"
            style={{ backgroundColor: '#ff795d' }}
          >
            + Neue Wohnung
          </button>
        </div>

        {/* Status pills */}
        <div className="flex flex-wrap gap-2 mt-4">
          {(['available', 'reserved', 'sold', 'under_construction'] as UnitStatus[]).map(s => {
            const n = units.filter(u => u.status === s).length
            return n > 0 ? (
              <span key={s} className={`px-3 py-1 rounded-full text-xs font-medium ${STATUS_PILL[s]}`}>
                {n} {STATUS_LABEL[s]}
              </span>
            ) : null
          })}
          {units.filter(u => u.is_completed).length > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
              {units.filter(u => u.is_completed).length} Übergeben
            </span>
          )}
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
            {units.length} Einheiten gesamt
          </span>
        </div>
      </div>

      {/* ── Units grid ── */}
      {units.length === 0 ? (
        <div className="text-center py-24 text-gray-400">
          <p className="text-5xl mb-3">🏗️</p>
          <p className="text-sm">Noch keine Wohnungen angelegt.</p>
          <button onClick={openNew} className="mt-4 text-sm text-[#ff795d] underline font-medium">
            Erste Wohnung anlegen
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(byBlock).sort(([a], [b]) => a.localeCompare(b)).map(([block, bUnits]) => (
            <div key={block}>
              {multiBlock && (
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 font-body">
                  {block === '—' ? 'Ohne Block' : `Block ${block}`}
                </h2>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {bUnits.map(u => (
                  <UnitCard key={u.id} unit={u} onClick={() => openEdit(u)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Unit Modal                                                            */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-4"
               onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 font-body">
                {editUnit
                  ? `${editUnit.block ? `Block ${editUnit.block} · ` : ''}${editUnit.unit_number}`
                  : 'Neue Wohnung'}
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 px-6 overflow-x-auto">
              {([
                { id: 'grunddaten',  label: 'Grunddaten' },
                { id: 'zahlungen',   label: `Zahlungen${payments.length > 0 ? ` (${payments.length})` : ''}` },
                { id: 'dokumente',   label: `Dokumente${documents.length > 0 ? ` (${documents.length})` : ''}` },
                { id: 'verwaltung',  label: 'Verwaltung' },
              ] as { id: ModalTab; label: string }[]).map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  disabled={t.id !== 'grunddaten' && !editUnit}
                  className={`whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors
                    disabled:opacity-30 disabled:cursor-not-allowed ${
                    tab === t.id
                      ? 'border-[#ff795d] text-[#ff795d]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab body */}
            <div className="px-6 py-5 overflow-y-auto max-h-[65vh]">

              {/* ── Grunddaten ──────────────────────────────────────────────── */}
              {tab === 'grunddaten' && (
                <div className="space-y-4">

                  {/* Block + Nummer */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Block</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder="z.B. A"
                        value={form.block}
                        onChange={e => setForm(f => ({ ...f, block: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Wohnungsnummer *</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder="z.B. 12 oder A-12"
                        value={form.unit_number}
                        onChange={e => setForm(f => ({ ...f, unit_number: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Typ + Status */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Typ</label>
                      <select
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.type}
                        onChange={e => setForm(f => ({ ...f, type: e.target.value as UnitType }))}
                      >
                        <option value="apartment">Wohnung</option>
                        <option value="villa">Villa</option>
                        <option value="studio">Studio</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                      <select
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.status}
                        onChange={e => setForm(f => ({ ...f, status: e.target.value as UnitStatus }))}
                      >
                        <option value="available">Verfügbar</option>
                        <option value="reserved">Reserviert</option>
                        <option value="sold">Verkauft</option>
                        <option value="under_construction">Im Bau</option>
                      </select>
                    </div>
                  </div>

                  {/* Flächen + Etage */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Wohnfläche (m²)</label>
                      <input
                        type="number" min="0" step="0.01"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder="z.B. 85"
                        value={form.size_sqm}
                        onChange={e => setForm(f => ({ ...f, size_sqm: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Terrasse (m²)</label>
                      <input
                        type="number" min="0" step="0.01"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder="z.B. 20"
                        value={form.terrace_sqm}
                        onChange={e => setForm(f => ({ ...f, terrace_sqm: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Etage</label>
                      <input
                        type="number" min="0"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder="z.B. 2"
                        value={form.floor}
                        onChange={e => setForm(f => ({ ...f, floor: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Zimmer */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Schlafzimmer</label>
                      <input
                        type="number" min="0"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        value={form.bedrooms}
                        onChange={e => setForm(f => ({ ...f, bedrooms: parseInt(e.target.value) || 0 }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Badezimmer</label>
                      <input
                        type="number" min="0"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        value={form.bathrooms}
                        onChange={e => setForm(f => ({ ...f, bathrooms: parseInt(e.target.value) || 0 }))}
                      />
                    </div>
                  </div>

                  {/* Preis */}
                  <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Preis Netto (€)</label>
                        <input
                          type="number" min="0" step="100"
                          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                          placeholder="190.000"
                          value={form.price_net}
                          onChange={e => handleNetChange(e.target.value)}
                        />
                      </div>
                      <span className="text-gray-400 pb-2 text-center">⇄</span>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Preis Brutto (€)</label>
                        <input
                          type="number" min="0" step="100"
                          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                          placeholder="199.500"
                          value={form.price_gross}
                          onChange={e => handleGrossChange(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="text-xs text-gray-500 whitespace-nowrap">MwSt. (%)</label>
                      <input
                        type="number" min="0" max="100" step="0.5"
                        className="w-20 rounded-xl border border-gray-200 px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.vat_rate}
                        onChange={e => handleVatChange(e.target.value)}
                      />
                      <span className="text-xs text-gray-400">
                        Netto eingeben → Brutto wird berechnet (und umgekehrt)
                      </span>
                    </div>
                  </div>

                  {/* Möblierung + Übergabe */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-2">Einrichtung</label>
                      <div className="flex gap-2">
                        {([false, true] as const).map(v => (
                          <button
                            key={String(v)}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, is_furnished: v }))}
                            className={`flex-1 py-2 text-xs rounded-xl border font-medium transition-colors ${
                              form.is_furnished === v
                                ? 'bg-gray-800 text-white border-gray-800'
                                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {v ? 'Möbliert' : 'Unmöbliert'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Übergabedatum</label>
                      <input
                        type="date"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        value={form.handover_date}
                        onChange={e => setForm(f => ({ ...f, handover_date: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Notizen */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Notizen</label>
                    <textarea
                      rows={2}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm resize-none focus:outline-none focus:border-[#ff795d]"
                      placeholder="Interne Notizen zur Wohnung…"
                      value={form.notes}
                      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              {/* ── Zahlungen ────────────────────────────────────────────────── */}
              {tab === 'zahlungen' && editUnit && (
                <div className="space-y-4">

                  {/* Summary */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-blue-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-blue-500 font-medium mb-0.5">Kaufpreis (Brutto)</p>
                      <p className="text-sm font-bold text-blue-800">{fmtPrice(totalPrice)}</p>
                    </div>
                    <div className="bg-green-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-green-500 font-medium mb-0.5">Bezahlt</p>
                      <p className="text-sm font-bold text-green-800">{fmtPrice(totalPaid)}</p>
                    </div>
                    <div className={`rounded-xl p-3 text-center ${outstanding > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <p className={`text-[10px] font-medium mb-0.5 ${outstanding > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                        Ausstehend
                      </p>
                      <p className={`text-sm font-bold ${outstanding > 0 ? 'text-red-800' : 'text-gray-600'}`}>
                        {fmtPrice(outstanding)}
                      </p>
                    </div>
                  </div>

                  {/* Payments list */}
                  {payLoading ? (
                    <div className="text-center py-6">
                      <span className="w-5 h-5 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin inline-block" />
                    </div>
                  ) : payments.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">Noch keine Raten eingetragen.</p>
                  ) : (
                    <div className="space-y-2">
                      {payments.map(pay => (
                        <div
                          key={pay.id}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${
                            pay.is_paid ? 'bg-green-50 border-green-100' : 'bg-white border-gray-100'
                          }`}
                        >
                          <button onClick={() => togglePaid(pay)} className="shrink-0">
                            <span className={`text-lg ${pay.is_paid ? 'text-green-500' : 'text-gray-300'}`}>
                              {pay.is_paid ? '✅' : '⬜'}
                            </span>
                          </button>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-800 truncate">{pay.description ?? '—'}</p>
                            <p className="text-xs text-gray-400 truncate">
                              {pay.due_date  ? `Fällig: ${fmtDate(pay.due_date)}` : ''}
                              {pay.paid_date ? ` · Bezahlt: ${fmtDate(pay.paid_date)}` : ''}
                              {pay.payment_reference ? ` · ${pay.payment_reference}` : ''}
                            </p>
                          </div>
                          <span className="shrink-0 font-bold text-gray-800">{fmtPrice(pay.amount)}</span>
                          <button
                            onClick={() => {
                              setEditPayId(pay.id)
                              setPayForm({
                                description:       pay.description       ?? '',
                                amount:            pay.amount.toString(),
                                due_date:          pay.due_date          ?? '',
                                paid_date:         pay.paid_date         ?? '',
                                is_paid:           pay.is_paid,
                                payment_reference: pay.payment_reference ?? '',
                              })
                            }}
                            className="text-gray-400 hover:text-gray-600 text-base shrink-0"
                          >
                            ✏️
                          </button>
                          <button
                            onClick={() => handleDeletePayment(pay.id)}
                            className="text-gray-300 hover:text-red-500 text-base shrink-0"
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add / Edit payment form */}
                  <div className="border border-dashed border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
                    <p className="text-xs font-semibold text-gray-500">
                      {editPayId ? 'Rate bearbeiten' : '+ Rate hinzufügen'}
                    </p>
                    <input
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                      placeholder="Bezeichnung (z.B. Anzahlung, 2. Rate)"
                      value={payForm.description}
                      onChange={e => setPayForm(f => ({ ...f, description: e.target.value }))}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="number" min="0" step="100"
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder="Betrag (€) *"
                        value={payForm.amount}
                        onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                      />
                      <input
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder="Referenznummer / Überweisung"
                        value={payForm.payment_reference}
                        onChange={e => setPayForm(f => ({ ...f, payment_reference: e.target.value }))}
                      />
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1">Fälligkeitsdatum</label>
                        <input
                          type="date"
                          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                          value={payForm.due_date}
                          onChange={e => setPayForm(f => ({ ...f, due_date: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1">Zahlungsdatum</label>
                        <input
                          type="date"
                          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                          value={payForm.paid_date}
                          onChange={e => setPayForm(f => ({
                            ...f, paid_date: e.target.value, is_paid: !!e.target.value,
                          }))}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={payForm.is_paid}
                          onChange={e => setPayForm(f => ({ ...f, is_paid: e.target.checked }))}
                          className="rounded"
                        />
                        <span className="text-xs text-gray-600">Bereits bezahlt</span>
                      </label>
                      <div className="flex gap-2 ml-auto">
                        {editPayId && (
                          <button
                            onClick={() => { setEditPayId(null); setPayForm({ ...EMPTY_PAY }) }}
                            className="px-3 py-2 text-xs text-gray-500 border border-gray-200 rounded-xl bg-white"
                          >
                            Abbrechen
                          </button>
                        )}
                        <button
                          onClick={handleSavePayment}
                          disabled={!payForm.amount || savingPay}
                          className="px-4 py-2 text-xs font-medium text-white rounded-xl disabled:opacity-50"
                          style={{ backgroundColor: '#ff795d' }}
                        >
                          {savingPay ? '…' : editPayId ? 'Aktualisieren' : 'Hinzufügen'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Dokumente ────────────────────────────────────────────────── */}
              {tab === 'dokumente' && editUnit && (
                <div className="space-y-4">

                  {/* Upload area */}
                  <div className="border border-dashed border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
                    <p className="text-xs font-semibold text-gray-500">Dokument hochladen</p>

                    <input
                      type="file"
                      ref={fileInputRef}
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        setPendingFile(f)
                        if (!docForm.name)
                          setDocForm(d => ({ ...d, name: f.name.replace(/\.[^.]+$/, '') }))
                      }}
                    />

                    {!pendingFile ? (
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full border-2 border-dashed border-gray-200 rounded-xl py-6 text-sm text-gray-400
                                   hover:border-[#ff795d] hover:text-[#ff795d] transition-colors"
                      >
                        📎 Datei auswählen (PDF, Word, Bild)
                      </button>
                    ) : (
                      <div className="bg-blue-50 rounded-xl p-3 flex items-center gap-3">
                        <span className="text-2xl">📄</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{pendingFile.name}</p>
                          <p className="text-xs text-gray-500">{formatFileSize(pendingFile.size)}</p>
                        </div>
                        <button
                          onClick={() => {
                            setPendingFile(null)
                            if (fileInputRef.current) fileInputRef.current.value = ''
                          }}
                          className="text-gray-400 hover:text-red-500"
                        >
                          ✕
                        </button>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <input
                        className="col-span-2 rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder="Dokumentenname *"
                        value={docForm.name}
                        onChange={e => setDocForm(d => ({ ...d, name: e.target.value }))}
                      />
                      <select
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        value={docForm.doc_type}
                        onChange={e => setDocForm(d => ({
                          ...d, doc_type: e.target.value as CrmUnitDocument['doc_type'],
                        }))}
                      >
                        <option value="kaufvertrag">Kaufvertrag</option>
                        <option value="zahlungsbeleg">Zahlungsbeleg</option>
                        <option value="grundriss">Grundriss</option>
                        <option value="sonstiges">Sonstiges</option>
                      </select>
                      <input
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder="Notiz (optional)"
                        value={docForm.notes}
                        onChange={e => setDocForm(d => ({ ...d, notes: e.target.value }))}
                      />
                    </div>

                    <button
                      onClick={handleUploadDoc}
                      disabled={!pendingFile || !docForm.name.trim() || uploadingDoc}
                      className="w-full py-2 text-sm font-medium text-white rounded-xl disabled:opacity-50"
                      style={{ backgroundColor: '#ff795d' }}
                    >
                      {uploadingDoc ? 'Wird hochgeladen…' : 'Hochladen'}
                    </button>
                  </div>

                  {/* Document list */}
                  {docLoading ? (
                    <div className="text-center py-6">
                      <span className="w-5 h-5 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin inline-block" />
                    </div>
                  ) : documents.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">Noch keine Dokumente.</p>
                  ) : (
                    <div className="space-y-2">
                      {documents.map(doc => (
                        <div
                          key={doc.id}
                          className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5"
                        >
                          <span className="text-xl shrink-0">📄</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{doc.name}</p>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${DOC_PILL[doc.doc_type]}`}>
                                {DOC_LABEL[doc.doc_type]}
                              </span>
                              {doc.file_size && (
                                <span className="text-xs text-gray-400">{formatFileSize(doc.file_size)}</span>
                              )}
                              <span className="text-xs text-gray-300">{fmtDate(doc.created_at)}</span>
                            </div>
                            {doc.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{doc.notes}</p>}
                          </div>
                          <button
                            onClick={() => handleOpenDoc(doc)}
                            className="text-blue-500 hover:text-blue-700 text-xs shrink-0 px-2 font-medium"
                          >
                            Öffnen
                          </button>
                          <button
                            onClick={() => handleDeleteDoc(doc)}
                            className="text-gray-300 hover:text-red-500 text-base shrink-0"
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Verwaltung ───────────────────────────────────────────────── */}
              {tab === 'verwaltung' && editUnit && (
                <div className="space-y-5">

                  {/* Übergabe abgeschlossen */}
                  <div className="bg-gray-50 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-gray-800">Übergabe abgeschlossen</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Wohnung wurde fertig übergeben
                        </p>
                      </div>
                      <button
                        onClick={() => setForm(f => ({ ...f, is_completed: !f.is_completed }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          form.is_completed ? 'bg-green-500' : 'bg-gray-200'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                          form.is_completed ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                    {form.is_completed && (
                      <p className="mt-2 text-xs text-green-600 font-medium">✅ Als abgeschlossen markiert</p>
                    )}
                  </div>

                  {/* Verwalter */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Verwalter zuweisen</label>
                    <select
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                      value={form.verwalter_id}
                      onChange={e => setForm(f => ({ ...f, verwalter_id: e.target.value }))}
                    >
                      <option value="">— Kein Verwalter —</option>
                      {verwalters.map(v => (
                        <option key={v.id} value={v.id}>{v.full_name}</option>
                      ))}
                    </select>
                    {verwalters.length === 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        Noch keine Verwalter angelegt.
                        Im Bereich Nutzer → Verwalter hinzufügen.
                      </p>
                    )}
                  </div>

                  {/* Miettyp */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-2">Miettyp</label>
                    <div className="flex gap-3">
                      {([
                        { v: '',      label: 'Nicht festgelegt' },
                        { v: 'short', label: '🏖️ Kurzzeitmiete'  },
                        { v: 'long',  label: '🏠 Langzeitmiete'  },
                      ] as { v: 'short' | 'long' | ''; label: string }[]).map(({ v, label }) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, rental_type: v }))}
                          className={`flex-1 py-2.5 text-xs rounded-xl border font-medium transition-colors ${
                            form.rental_type === v
                              ? 'bg-gray-800 text-white border-gray-800'
                              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
              <div>
                {editUnit && (
                  <button
                    onClick={() => handleDeleteUnit(editUnit.id)}
                    className="text-sm text-red-400 hover:text-red-600"
                  >
                    Wohnung löschen
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
                >
                  Schließen
                </button>
                {(tab === 'grunddaten' || tab === 'verwaltung') && (
                  <button
                    onClick={handleSaveUnit}
                    disabled={!form.unit_number.trim() || saving}
                    className="px-5 py-2 text-sm font-medium text-white rounded-xl disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {saving ? 'Speichern…' : editUnit ? 'Aktualisieren' : 'Erstellen'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
