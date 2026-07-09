import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type {
  CrmProject, CrmProjectUnit, CrmUnitDocument, CrmUnitPayment,
  UnitType, UnitStatus,
} from '../../../lib/crmTypes'
import { CustomSelect } from '../../../components/CustomSelect'
import ConstructionPhotos from '../../../components/crm/ConstructionPhotos'

// ── Local types ───────────────────────────────────────────────────────────────

type ModalTab = 'grunddaten' | 'bilder' | 'zahlungen' | 'dokumente' | 'verwaltung'

interface Verwalter { id: string; full_name: string }

type UnitLead = { id: string; first_name: string; last_name: string; email: string } | null

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
  under_construction: 'bg-blue-100 text-blue-700',
  active:             'bg-green-100 text-green-700',
  proposal:           'bg-amber-100 text-amber-700',
  reserved:           'bg-purple-100 text-purple-700',
  sold:               'bg-red-100 text-red-700',
}
const STATUS_BAR: Record<UnitStatus, string> = {
  under_construction: '#3b82f6',
  active:             '#22c55e',
  proposal:           '#f59e0b',
  reserved:           '#a855f7',
  sold:               '#ef4444',
}
const DOC_PILL: Record<string, string> = {
  kaufvertrag:  'bg-purple-100 text-purple-700',
  mietvertrag:  'bg-indigo-100 text-indigo-700',
  zahlungsbeleg:'bg-green-100 text-green-700',
  grundriss:    'bg-blue-100 text-blue-700',
  rechnung:     'bg-amber-100 text-amber-700',
  sonstiges:    'bg-gray-100 text-gray-600',
}

// ── Empty form defaults ───────────────────────────────────────────────────────

const EMPTY_FORM = {
  block: '', unit_number: '',
  type: 'apartment' as UnitType, status: 'active' as UnitStatus,
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
  unit, onClick, customer, onCustomerClick, onAssignCustomer, onContextMenu,
}: {
  unit: CrmProjectUnit
  onClick: () => void
  customer?: UnitLead
  onCustomerClick?: () => void
  onAssignCustomer?: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  const { t } = useTranslation()
  const price = unit.price_gross ?? unit.price_net
  return (
    <div
      className="bg-white rounded-2xl border border-gray-100 shadow-sm
                 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer overflow-hidden"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* Unit image thumbnail (if available) */}
      {unit.images?.length > 0 ? (
        <div className="h-28 overflow-hidden">
          <img src={unit.images[0]} alt={unit.unit_number} className="w-full h-full object-cover" />
        </div>
      ) : (
        /* Status colour bar */
        <div
          className="h-1.5"
          style={{ backgroundColor: unit.is_completed ? '#22c55e' : STATUS_BAR[unit.status] }}
        />
      )}

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between mb-2">
          <div>
            {unit.block && (
              <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                {t('projectDetail.blockLabel', 'Block {{block}}', { block: unit.block })} ·{' '}
              </span>
            )}
            <span className="text-base font-bold text-gray-900 font-body">{unit.unit_number}</span>
            <div className="mt-1">
              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_PILL[unit.status]}`}>
                {unit.is_completed ? t('crm.pd.handedOver') : t(`crm.pd.status.${unit.status}`)}
              </span>
            </div>
          </div>
          {unit.rental_type && (
            <span className="text-xl" title={unit.rental_type === 'short' ? t('crm.pd.rentalShortTitle') : t('crm.pd.rentalLongTitle')}>
              {unit.rental_type === 'short' ? '🏖️' : '🏠'}
            </span>
          )}
        </div>

        {/* Details */}
        <div className="space-y-0.5 text-xs text-gray-500 mt-3">
          {unit.size_sqm != null && (
            <p>
              📐 {unit.size_sqm} m²
              {unit.terrace_sqm != null ? ` · ${unit.terrace_sqm} m² ${t('crm.pd.terrace')}` : ''}
            </p>
          )}
          {(unit.bedrooms > 0 || unit.bathrooms > 0) && (
            <p>🛏️ {unit.bedrooms} {t('crm.unitSelect.bedroomsAbbr')} · 🚿 {unit.bathrooms} {t('crm.assignUnit.bathAbbr')}</p>
          )}
          {price != null && (
            <p className="font-semibold text-gray-700 mt-1">
              💶 {fmtPrice(price)}
              {unit.price_gross == null && unit.price_net != null ? t('crm.pd.netSuffix') : ''}
            </p>
          )}
          {unit.handover_date && <p>📅 {t('crm.pd.handover')} {fmtDate(unit.handover_date)}</p>}
          {unit.verwalter && <p>👤 {unit.verwalter.full_name}</p>}
          {unit.is_furnished && <p>🛋️ {t('crm.unitEdit.furnished')}</p>}
        </div>

        {/* Customer badge — clickable → LeadDetail */}
        {customer ? (
          <div className="mt-3 pt-2.5 border-t border-gray-100">
            <button
              onClick={e => { e.stopPropagation(); onCustomerClick?.() }}
              className="flex items-center gap-1.5 w-full text-left hover:text-[#ff795d] transition-colors group"
            >
              <span className="text-[10px]">👤</span>
              <span className="text-[10px] font-semibold text-gray-700 truncate group-hover:text-[#ff795d]">
                {customer.first_name} {customer.last_name}
              </span>
              <span className="text-[9px] text-[#ff795d] ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
            </button>
          </div>
        ) : (
          <div className="mt-3 pt-2.5 border-t border-gray-100">
            <button
              onClick={e => { e.stopPropagation(); onAssignCustomer?.() }}
              className="flex items-center gap-1.5 text-[10px] text-gray-400 hover:text-[#ff795d] transition-colors"
            >
              <span>👤</span>
              <span>{t('crm.pd.assignCustomer')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Unit image helpers ────────────────────────────────────────────────────────

const UNIT_IMG_BUCKET = 'unit-images'
const PROJ_IMG_BUCKET = 'crm-project-images'

async function uploadUnitImage(file: File, unitId: string): Promise<string | null> {
  const ext  = file.name.split('.').pop() ?? 'jpg'
  const path = `units/${unitId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage
    .from(UNIT_IMG_BUCKET)
    .upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) return null
  const { data } = supabase.storage.from(UNIT_IMG_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

async function deleteUnitImage(url: string) {
  const marker = `/${UNIT_IMG_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return
  const path = url.slice(idx + marker.length)
  await supabase.storage.from(UNIT_IMG_BUCKET).remove([path])
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectDetail() {
  const { t } = useTranslation()
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { profile } = useAuth()

  // ── Core data ────────────────────────────────────────────────────────────────
  const [project,      setProject]      = useState<CrmProject | null>(null)
  const [units,        setUnits]        = useState<CrmProjectUnit[]>([])
  const [verwalters,   setVerwalters]   = useState<Verwalter[]>([])
  const [unitLeadMap,  setUnitLeadMap]  = useState<Record<string, UnitLead>>({})
  const [loading,      setLoading]      = useState(true)
  const [toast,        setToast]        = useState('')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  // ── Modal ────────────────────────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false)
  const [editUnit,  setEditUnit]  = useState<CrmProjectUnit | null>(null)
  const [tab,       setTab]       = useState<ModalTab>('grunddaten')
  const [saving,    setSaving]    = useState(false)
  const [form,      setForm]      = useState({ ...EMPTY_FORM })

  // ── Unit Images ──────────────────────────────────────────────────────────────
  const [unitImages,        setUnitImages]        = useState<string[]>([])
  const [uploadingUnitImg,  setUploadingUnitImg]  = useState(false)
  const unitImgInputRef = useRef<HTMLInputElement>(null)

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

  // ── Projektbilder ────────────────────────────────────────────────────────────
  const [uploadingProjectImg, setUploadingProjectImg] = useState(false)
  const projectImgInputRef = useRef<HTMLInputElement>(null)

  // ── Property-Verknüpfung ─────────────────────────────────────────────────────
  const [linkableProperties, setLinkableProperties] = useState<Array<{
    id: string; project_name: string; unit_number: string | null
  }>>([])
  const [linkPropId,     setLinkPropId]     = useState('')
  const [linkPropSaving, setLinkPropSaving] = useState(false)

  // ── Customer assignment ──────────────────────────────────────────────────────
  const [showAssignModal,  setShowAssignModal]  = useState(false)
  const [assigningUnit,    setAssigningUnit]    = useState<CrmProjectUnit | null>(null)
  const [unitCtx,          setUnitCtx]          = useState<{ x: number; y: number; unit: CrmProjectUnit } | null>(null)
  const [assignLeadQuery,  setAssignLeadQuery]  = useState('')
  const [assignLeadResults, setAssignLeadResults] = useState<Array<{
    id: string; first_name: string; last_name: string; email: string; deal_id: string | null
  }>>([])
  const [assignLeadSearching, setAssignLeadSearching] = useState(false)
  const [assignLeadSaving,    setAssignLeadSaving]    = useState(false)

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
      const fetchedUnits = (unitsRes.data ?? []) as CrmProjectUnit[]
      setUnits(fetchedUnits)
      setVerwalters((verwRes.data ?? []) as Verwalter[])

      // ── Kundenzuordnung: welcher Lead ist welcher Einheit zugewiesen? ──────
      // Fehler ignorieren falls deals.unit_id noch nicht in der DB existiert
      if (fetchedUnits.length > 0) {
        try {
          const unitIds = fetchedUnits.map(u => u.id)
          const { data: dealsData, error: dealsErr } = await supabase
            .from('deals')
            .select('unit_id, lead:lead_id(id, first_name, last_name, email)')
            .in('unit_id', unitIds)
            .neq('phase', 'archiviert')
          if (!dealsErr && dealsData) {
            const map: Record<string, UnitLead> = {}
            for (const d of dealsData as unknown as Array<{ unit_id: string; lead: UnitLead }>) {
              if (d.unit_id && d.lead) map[d.unit_id] = d.lead
            }
            setUnitLeadMap(map)
          }
        } catch {
          // deals.unit_id Spalte fehlt noch — Kundenzuordnung deaktiviert
          setUnitLeadMap({})
        }
      } else {
        setUnitLeadMap({})
      }
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Einheit löschen (Rechtsklick-Kontextmenü auf der Kachel) ─────────────────
  const deleteUnit = async (u: CrmProjectUnit) => {
    setUnitCtx(null)
    const { data: linked } = await supabase.from('deals').select('id').eq('unit_id', u.id).maybeSingle()
    if (linked) { alert(t('crm.pd.unitDealLinked', 'Diese Einheit ist einem Deal zugeordnet — erst dort entfernen, dann löschen.')); return }
    if (!window.confirm(t('crm.pd.unitDeleteConfirm', 'Einheit {{n}} wirklich löschen?', { n: u.unit_number }))) return
    const { error } = await supabase.from('crm_project_units').delete().eq('id', u.id)
    if (error) { alert(t('projectDetail.deleteUnitError', 'Fehler: {{msg}}', { msg: error.message })); return }
    await fetchData()
  }


  // ── Verknüpfbare Portal-Immobilien laden ─────────────────────────────────────
  async function fetchLinkableProperties(currentPropertyId?: string | null) {
    // Alle property_ids die bereits von ANDEREN Einheiten belegt sind
    const { data: used } = await supabase
      .from('crm_project_units')
      .select('property_id')
      .not('property_id', 'is', null)
    const usedByOther = new Set(
      ((used ?? []) as { property_id: string }[])
        .map(r => r.property_id)
        .filter(pid => pid !== currentPropertyId) // aktuell verknüpfte behalten
    )
    const { data } = await supabase
      .from('properties')
      .select('id, project_name, unit_number')
      .order('project_name')
    setLinkableProperties(
      ((data ?? []) as Array<{ id: string; project_name: string; unit_number: string | null }>)
        .filter(p => !usedByOther.has(p.id))
    )
  }

  async function handleLinkProperty() {
    if (!editUnit || !linkPropId) return
    setLinkPropSaving(true)
    try {
      const { error } = await supabase
        .from('crm_project_units')
        .update({ property_id: linkPropId })
        .eq('id', editUnit.id)
      if (error) throw error
      showToast(t('crm.pd.toastLinked'))
      setEditUnit(prev => prev ? { ...prev, property_id: linkPropId } : prev)
      setLinkPropId('')
      await fetchData()
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally { setLinkPropSaving(false) }
  }

  async function handleUnlinkProperty() {
    if (!editUnit) return
    setLinkPropSaving(true)
    try {
      const { error } = await supabase
        .from('crm_project_units')
        .update({ property_id: null })
        .eq('id', editUnit.id)
      if (error) throw error
      showToast(t('crm.pd.toastUnlinked'))
      setEditUnit(prev => prev ? { ...prev, property_id: null } : prev)
      await fetchData()
      await fetchLinkableProperties(null)
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally { setLinkPropSaving(false) }
  }

  // ── E-Mail-Benachrichtigung beim Upload ──────────────────────────────────────
  async function notifyCustomerUpload(
    email: string, firstName: string,
    fileName: string, kind: 'Dokument' | 'Bild' | 'Baustellenfoto',
  ) {
    try {
      await supabase.functions.invoke('send-email', {
        body: {
          to:      email,
          subject: `Neue Datei in Ihrem Happy Property Portal`,
          html:    `<p>Hallo ${firstName},</p>
<p>es wurde ein neues <strong>${kind}</strong> für Ihre Immobilie hochgeladen: <em>${fileName}</em></p>
<p>Sie können es jederzeit in Ihrem persönlichen Portal einsehen.</p>
<p>Viele Grüße<br>Ihr Happy Property Team</p>`,
        },
      })
    } catch (err) {
      console.warn('[ProjectDetail] notifyCustomerUpload failed:', err)
    }
  }

  // ── Search leads for assignment ──────────────────────────────────────────────
  async function searchLeadsForAssign(query: string) {
    if (!query.trim() || query.trim().length < 2) { setAssignLeadResults([]); return }
    setAssignLeadSearching(true)
    try {
      const { data } = await supabase
        .from('leads')
        .select('id, first_name, last_name, email')
        .or(`first_name.ilike.%${query.trim()}%,last_name.ilike.%${query.trim()}%,email.ilike.%${query.trim()}%`)
        .limit(8)
      // For each lead, find their active deal
      const leads = (data ?? []) as Array<{id: string; first_name: string; last_name: string; email: string}>
      if (leads.length === 0) { setAssignLeadResults([]); return }
      const { data: dealData } = await supabase
        .from('deals')
        .select('id, lead_id, phase')
        .in('lead_id', leads.map(l => l.id))
        .neq('phase', 'archiviert')
      const dealByLead: Record<string, string> = {}
      for (const d of (dealData ?? []) as Array<{id: string; lead_id: string; phase: string}>) {
        dealByLead[d.lead_id] = d.id
      }
      setAssignLeadResults(leads.map(l => ({
        ...l, deal_id: dealByLead[l.id] ?? null,
      })))
    } finally { setAssignLeadSearching(false) }
  }

  async function handleAssignLeadToUnit(leadId: string, dealId: string | null) {
    if (!assigningUnit) return
    setAssignLeadSaving(true)
    try {
      if (dealId) {
        const dealUpdate: Record<string, unknown> = { unit_id: assigningUnit.id }
        if (assigningUnit.property_id) dealUpdate.property_id = assigningUnit.property_id
        const { error } = await supabase
          .from('deals')
          .update(dealUpdate)
          .eq('id', dealId)
        if (error) throw error
      }
      // Bau-Status folgt dem Projekt (Quelle der Wahrheit) — eine Kundenzuweisung
      // ändert NICHT den Bau-Status. "Verkauft" ergibt sich aus der Zuordnung
      // (deal.unit_id / owner_id), nicht aus unit.status.
      const unitBuildStatus = project?.status === 'under_construction' ? 'under_construction' : 'active'
      await supabase.from('crm_project_units')
        .update({ status: unitBuildStatus })
        .eq('id', assigningUnit.id)
      // Log activity
      await supabase.from('activities').insert({
        lead_id:      leadId,
        deal_id:      dealId,
        type:         'note',
        direction:    'outbound',
        subject:      'Wohnung zugewiesen',
        content:      `Einheit Nr. ${assigningUnit.unit_number} (Projekt: ${project?.name ?? ''}) wurde diesem Lead zugewiesen.`,
        created_by:   profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })

      // Portal-Eintrag synchronisieren (wenn Eigentümer-Profil bereits vorhanden)
      const { data: leadData } = await supabase
        .from('leads')
        .select('email')
        .eq('id', leadId)
        .maybeSingle()
      if (leadData?.email && profile?.id) {
        const { data: ownerProfile } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', leadData.email)
          .eq('role', 'eigentuemer')
          .maybeSingle()
        if (ownerProfile) {
          const unit = assigningUnit
          // rental_type NOT NULL in DB → 'longterm' als Fallback
          const rentalType: 'shortterm' | 'longterm' =
            unit.rental_type === 'long' ? 'longterm'
            : unit.rental_type === 'short' ? 'shortterm'
            : 'longterm'
          // Nur Portal-Management-Felder synchronisieren — Specs leben in crm_project_units
          const propData = {
            project_name:    project?.name ?? '',
            unit_number:     unit.unit_number || null,
            rental_type:     rentalType,
            city:            project?.location ?? null,
            property_status: unitBuildStatus,
          }
          if (unit.property_id) {
            await supabase.from('properties').update(propData).eq('id', unit.property_id)
          } else {
            const { data: newProp } = await supabase
              .from('properties')
              .insert({ ...propData, owner_id: (ownerProfile as { id: string }).id, created_by: profile.id, images: [] })
              .select('id')
              .single()
            if (newProp) {
              const newPropId = (newProp as { id: string }).id
              await supabase.from('crm_project_units').update({ property_id: newPropId }).eq('id', unit.id)
              if (dealId) await supabase.from('deals').update({ property_id: newPropId }).eq('id', dealId)
            }
          }
        }
      }

      showToast(t('crm.pd.toastCustomerAssigned'))
      setShowAssignModal(false)
      setAssigningUnit(null)
      setAssignLeadQuery('')
      setAssignLeadResults([])
      await fetchData()
    } catch (err) {
      showToast(t('crm.pd.toastError', { msg: err instanceof Error ? err.message : String(err) }))
    } finally { setAssignLeadSaving(false) }
  }

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
    setForm({
      ...EMPTY_FORM,
      status: project?.status === 'under_construction' ? 'under_construction' : 'active',
    })
    setPayments([])
    setDocuments([])
    setUnitImages([])
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
    setUnitImages(unit.images ?? [])
    setLinkPropId('')
    setTab('grunddaten')
    setShowModal(true)
    fetchPayments(unit.id)
    fetchDocuments(unit.id)
    fetchLinkableProperties(unit.property_id)
  }

  function closeModal() {
    setShowModal(false)
    setEditUnit(null)
    setPendingFile(null)
    setEditPayId(null)
    setPayForm({ ...EMPTY_PAY })
    setLinkPropId('')
    setLinkableProperties([])
  }

  // ── Unit image upload / delete ───────────────────────────────────────────────
  async function handleUploadUnitImages(files: FileList) {
    if (!editUnit && !form.unit_number.trim()) return
    setUploadingUnitImg(true)
    try {
      // If new unit: we don't have an id yet → save first, then upload
      // For existing units upload immediately
      const unitId = editUnit?.id
      if (!unitId) {
        showToast(t('crm.pd.toastSaveFirst'))
        return
      }
      const newUrls: string[] = []
      for (let i = 0; i < files.length; i++) {
        const url = await uploadUnitImage(files[i], unitId)
        if (url) newUrls.push(url)
      }
      if (newUrls.length === 0) { showToast(t('crm.pd.toastUploadFailed')); return }
      const updated = [...unitImages, ...newUrls]
      const { error } = await supabase.from('crm_project_units')
        .update({ images: updated })
        .eq('id', unitId)
      if (error) throw error
      setUnitImages(updated)
      showToast(t('crm.pd.toastImagesUploaded', { count: newUrls.length }))
      await fetchData()
      // E-Mail an Kunden senden
      const customer = unitLeadMap[unitId]
      if (customer?.email) {
        void notifyCustomerUpload(customer.email, customer.first_name, `${newUrls.length} neues Bild${newUrls.length > 1 ? 'er' : ''}`, 'Bild')
      }
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('errors.generic')}`)
    } finally {
      setUploadingUnitImg(false)
      if (unitImgInputRef.current) unitImgInputRef.current.value = ''
    }
  }

  async function handleDeleteUnitImage(url: string) {
    if (!editUnit) return
    const updated = unitImages.filter(u => u !== url)
    await deleteUnitImage(url)
    const { error } = await supabase.from('crm_project_units')
      .update({ images: updated })
      .eq('id', editUnit.id)
    if (!error) {
      setUnitImages(updated)
      await fetchData()
    }
  }

  // ── Projektbilder Upload / Delete ───────────────────────────────────────────

  async function handleUploadProjectImages(files: FileList) {
    if (!projectId || files.length === 0) return
    setUploadingProjectImg(true)
    try {
      const newUrls: string[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `projects/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from(PROJ_IMG_BUCKET)
          .upload(path, file, { upsert: false })
        if (upErr) { showToast(t('crm.pd.toastUploadFailedMsg', { msg: upErr.message })); continue }
        const { data: urlData } = supabase.storage.from(PROJ_IMG_BUCKET).getPublicUrl(path)
        if (urlData?.publicUrl) newUrls.push(urlData.publicUrl)
      }
      if (newUrls.length === 0) { showToast(t('crm.pd.toastNoImageUploaded')); return }
      const updated = [...(project?.images ?? []), ...newUrls]
      const { error } = await supabase.from('crm_projects').update({ images: updated }).eq('id', projectId)
      if (error) throw error
      setProject(p => p ? { ...p, images: updated } : p)
      showToast(t('crm.pd.toastProjectImagesUploaded', { count: newUrls.length }))
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('errors.generic')}`)
    } finally {
      setUploadingProjectImg(false)
      if (projectImgInputRef.current) projectImgInputRef.current.value = ''
    }
  }

  async function handleDeleteProjectImage(url: string) {
    if (!project || !window.confirm(t('crm.pd.confirmDeleteProjectImage'))) return
    const marker = `/${PROJ_IMG_BUCKET}/`
    const idx = url.indexOf(marker)
    if (idx !== -1) {
      const path = url.slice(idx + marker.length)
      await supabase.storage.from(PROJ_IMG_BUCKET).remove([path])
    }
    const updated = (project.images ?? []).filter(u => u !== url)
    const { error } = await supabase.from('crm_projects').update({ images: updated }).eq('id', projectId)
    if (!error) setProject(p => p ? { ...p, images: updated } : p)
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
    const wasUnderConstruction = editUnit ? editUnit.status === 'under_construction' : false
    const isNowActive          = form.status === 'active'
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
        images:       unitImages,
      }
      if (editUnit) {
        const { error } = await supabase.from('crm_project_units').update(payload).eq('id', editUnit.id)
        if (error) throw error

        // Sync rental_type + property_status back to linked property
        if (editUnit.property_id) {
          const propUpdate: Record<string, string> = {}

          // rental_type sync (immer, auch wenn leer → null)
          const propRentalType = form.rental_type === 'long' ? 'longterm'
            : form.rental_type === 'short' ? 'shortterm' : null
          propUpdate.rental_type            = propRentalType ?? ''
          propUpdate.management_rental_type = propRentalType ?? ''

          // property_status sync: under_construction ↔ under_construction, alles andere → active
          propUpdate.property_status = form.status === 'under_construction' ? 'under_construction' : 'active'

          await supabase
            .from('properties')
            .update(propUpdate)
            .eq('id', editUnit.property_id)
        }
      } else {
        const { data: newUnit, error } = await supabase
          .from('crm_project_units')
          .insert(payload)
          .select()
          .single()
        if (error) throw error
        // Offer customer assignment for active units
        if (newUnit && form.status !== 'under_construction') {
          await fetchData()
          showToast(t('crm.pd.toastUnitCreated'))
          setShowModal(false)
          setAssigningUnit(newUnit as CrmProjectUnit)
          setShowAssignModal(true)
          return
        }
      }
      await fetchData()
      showToast(editUnit ? t('crm.pd.toastUnitUpdated') : t('crm.pd.toastUnitCreated'))
      setShowModal(false)
      // Wenn von "Im Bau" → "Aktiv" gewechselt: Portal-Dialog anbieten
      if (wasUnderConstruction && isNowActive) {
        setPortalSuccess(false)
        setPortalError('')
        setShowPortalDialog(true)
      }
    } catch (err) {
      console.error('[ProjectDetail] saveUnit:', err)
      showToast(t('crm.pd.toastError', { msg: err instanceof Error ? err.message : String(err) }))
    } finally { setSaving(false) }
  }

  // ── Delete unit ──────────────────────────────────────────────────────────────
  async function handleDeleteUnit(id: string) {
    // Erst prüfen, ob die Einheit einem Deal zugeordnet ist — sonst würde ein
    // aktiver Deal verwaisen (gleicher Schutz wie im Rechtsklick-Löschpfad).
    const { data: linked } = await supabase.from('deals').select('id').eq('unit_id', id).maybeSingle()
    if (linked) { alert(t('crm.pd.unitDealLinked', 'Diese Einheit ist einem Deal zugeordnet — erst dort entfernen, dann löschen.')); return }
    if (!window.confirm(t('crm.pd.confirmDeleteUnit'))) return
    try {
      // Verknüpftes Portal-Objekt (properties) mit aufräumen, damit es nicht
      // verwaist beim Eigentümer/in der Verwaltung hängen bleibt.
      const { data: u } = await supabase
        .from('crm_project_units').select('property_id').eq('id', id).maybeSingle()
      const propId = (u as { property_id: string | null } | null)?.property_id ?? null

      const { error } = await supabase.from('crm_project_units').delete().eq('id', id)
      if (error) throw error

      if (propId) { await supabase.from('properties').delete().eq('id', propId) }

      setShowModal(false)
      await fetchData()
    } catch (err) {
      console.error('[ProjectDetail] handleDeleteUnit:', err)
      showToast(t('crm.pd.toastDeleteError'))
    }
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
        const { error } = await supabase.from('crm_unit_payments').update(payload).eq('id', editPayId)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('crm_unit_payments').insert(payload)
        if (error) throw new Error(error.message)
      }
      setPayForm({ ...EMPTY_PAY }); setEditPayId(null)
      await fetchPayments(editUnit.id)
      showToast(t('crm.pd.toastPaymentSaved'))
    } catch (err) {
      showToast(t('crm.pd.toastError', { msg: err instanceof Error ? err.message : String(err) }))
    } finally { setSavingPay(false) }
  }

  async function handleDeletePayment(id: string) {
    if (!editUnit) return
    if (!window.confirm(t('crm.pd.confirmDeletePayment', 'Diese Zahlung wirklich löschen?'))) return
    const { error } = await supabase.from('crm_unit_payments').delete().eq('id', id)
    if (error) { showToast(t('crm.pd.toastError', { msg: error.message })); return }
    await fetchPayments(editUnit.id)
  }

  async function togglePaid(pay: CrmUnitPayment) {
    if (savingPay) return   // Doppelklick-Schutz (Race vermeiden)
    setSavingPay(true)
    const { error } = await supabase.from('crm_unit_payments').update({
      is_paid:   !pay.is_paid,
      paid_date: !pay.is_paid ? new Date().toISOString().slice(0, 10) : null,
    }).eq('id', pay.id)
    if (error) { showToast(t('crm.pd.toastError', { msg: error.message })); setSavingPay(false); return }
    if (editUnit) await fetchPayments(editUnit.id)
    setSavingPay(false)
  }

  // ── Portal access ────────────────────────────────────────────────────────────
  const [portalEmail,   setPortalEmail]   = useState('')
  const [portalName,    setPortalName]    = useState('')
  const [portalSending, setPortalSending] = useState(false)
  const [portalSuccess, setPortalSuccess] = useState(false)
  const [portalError,   setPortalError]   = useState('')

  // Dialog shown after saving a unit that was changed TO 'sold'
  const [showPortalDialog, setShowPortalDialog] = useState(false)

  async function sendPortalAccess(email: string, name: string) {
    if (!email.trim() || !name.trim()) return
    setPortalSending(true)
    setPortalError('')
    try {
      const { error } = await supabase.functions.invoke('create-eigentuemer-access', {
        body: { email: email.trim(), full_name: name.trim() },
      })
      if (error) throw error
      setPortalSuccess(true)
      setPortalEmail('')
      setPortalName('')
      setTimeout(() => setPortalSuccess(false), 6000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPortalError(t('crm.pd.errorPrefix', { msg }))
    } finally {
      setPortalSending(false)
    }
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
      // E-Mail an Kunden senden
      const customer = unitLeadMap[editUnit.id]
      if (customer?.email) {
        void notifyCustomerUpload(customer.email, customer.first_name, docForm.name.trim() || pendingFile.name, 'Dokument')
      }
    } catch (err) {
      console.error('[ProjectDetail] Upload error:', err)
    } finally { setUploadingDoc(false) }
  }

  async function handleDeleteDoc(doc: CrmUnitDocument) {
    if (!editUnit || !window.confirm(t('crm.pd.confirmDeleteDoc'))) return
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
      <div className="text-center py-20 text-gray-400">{t('crm.pd.notFound')}</div>
    </DashboardLayout>
  )

  return (
    <DashboardLayout basePath="/admin/crm">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      {/* ── Page header ── */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/admin/crm/projects')}
          className="text-sm text-gray-400 hover:text-gray-600 mb-3 inline-flex items-center gap-1"
        >
          {t('crm.pd.backToProjects')}
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
            {t('crm.pd.newUnit')}
          </button>
        </div>

        {/* Status pills */}
        <div className="flex flex-wrap gap-2 mt-4">
          {(['under_construction', 'active'] as UnitStatus[]).map(s => {
            const n = units.filter(u => u.status === s).length
            return n > 0 ? (
              <span key={s} className={`px-3 py-1 rounded-full text-xs font-medium ${STATUS_PILL[s]}`}>
                {n} {t(`crm.pd.status.${s}`)}
              </span>
            ) : null
          })}
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
            {units.length} {t('crm.pd.unitsTotal')}
          </span>
        </div>
      </div>

      {/* ── Units grid ── */}
      {units.length === 0 ? (
        <div className="text-center py-24 text-gray-400">
          <p className="text-5xl mb-3">🏗️</p>
          <p className="text-sm">{t('crm.pd.noUnits')}</p>
          <button onClick={openNew} className="mt-4 text-sm text-[#ff795d] underline font-medium">
            {t('crm.pd.createFirstUnit')}
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(byBlock).sort(([a], [b]) => a.localeCompare(b)).map(([block, bUnits]) => (
            <div key={block}>
              {multiBlock && (
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 font-body">
                  {block === '—' ? t('crm.pd.noBlock') : t('projectDetail.blockLabel', 'Block {{block}}', { block })}
                </h2>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {bUnits.map(u => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    onClick={() => openEdit(u)}
                    customer={unitLeadMap[u.id] ?? undefined}
                    onCustomerClick={() => navigate(`/admin/crm/leads/${unitLeadMap[u.id]?.id}`)}
                    onAssignCustomer={() => { setAssigningUnit(u); setShowAssignModal(true) }}
                    onContextMenu={(e) => { e.preventDefault(); setUnitCtx({ x: e.clientX, y: e.clientY, unit: u }) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Projektbilder ── */}
      <div className="mt-10 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">{t('crm.pd.projectImages')}</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {t('crm.pd.projectImagesDesc')}
            </p>
          </div>
          <label className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors
            ${uploadingProjectImg ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-orange-50 text-[#ff795d] border border-[#ff795d] hover:bg-orange-100'}`}>
            {uploadingProjectImg ? t('crm.pd.uploading') : t('crm.pd.uploadImages')}
            <input
              ref={projectImgInputRef}
              type="file"
              accept="image/*"
              multiple
              disabled={uploadingProjectImg}
              className="hidden"
              onChange={e => { if (e.target.files?.length) handleUploadProjectImages(e.target.files) }}
            />
          </label>
        </div>
        {(project.images ?? []).length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-10">
            {t('crm.pd.noProjectImages')}
          </p>
        ) : (
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {(project.images ?? []).map((url, idx) => (
              <div key={url} className="relative group rounded-xl overflow-hidden border border-gray-100 bg-gray-50">
                <img
                  src={url}
                  alt={t('crm.pd.projectImageAlt', { n: idx + 1 })}
                  className="w-full h-32 object-cover cursor-pointer"
                  onClick={() => window.open(url, '_blank')}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
                <button
                  onClick={() => handleDeleteProjectImage(url)}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white text-xs
                             opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  title={t('crm.pd.delete')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Baustellenbilder ── */}
      <div className="mt-6">
        {projectId && <ConstructionPhotos projectId={projectId} />}
      </div>

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
                  ? `${editUnit.block ? t('projectDetail.blockPrefix', 'Block {{block}} · ', { block: editUnit.block }) : ''}${editUnit.unit_number}`
                  : t('crm.pd.newUnitTitle')}
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 px-6 overflow-x-auto">
              {([
                { id: 'grunddaten',  label: t('crm.pd.tabBasics') },
                { id: 'bilder',      label: `${t('crm.pd.tabImages')}${unitImages.length > 0 ? ` (${unitImages.length})` : ''}` },
                { id: 'zahlungen',   label: `${t('crm.pd.tabPayments')}${payments.length > 0 ? ` (${payments.length})` : ''}` },
                { id: 'dokumente',   label: `${t('crm.pd.tabDocuments')}${documents.length > 0 ? ` (${documents.length})` : ''}` },
                { id: 'verwaltung',  label: t('crm.pd.tabManagement') },
              ] as { id: ModalTab; label: string }[]).map(tb => (
                <button
                  key={tb.id}
                  onClick={() => setTab(tb.id)}
                  disabled={tb.id !== 'grunddaten' && !editUnit}
                  className={`whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors
                    disabled:opacity-30 disabled:cursor-not-allowed ${
                    tab === tb.id
                      ? 'border-[#ff795d] text-[#ff795d]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tb.label}
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
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.block')}</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder={t('crm.unitEdit.blockPlaceholder')}
                        value={form.block}
                        onChange={e => setForm(f => ({ ...f, block: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.pd.unitNumber')} *</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder={t('crm.pd.unitNumberPlaceholder')}
                        value={form.unit_number}
                        onChange={e => setForm(f => ({ ...f, unit_number: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Typ + Status */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unit.type')}</label>
                      <CustomSelect
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.type}
                        onChange={val => setForm(f => ({ ...f, type: val as UnitType }))}
                        options={[
                          { value: 'apartment', label: t('crm.unit.types.apartment') },
                          { value: 'villa',     label: t('crm.unit.types.villa') },
                          { value: 'studio',    label: t('crm.unit.types.studio') },
                        ]}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unit.status')}</label>
                      <CustomSelect
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.status}
                        onChange={val => setForm(f => ({ ...f, status: val as UnitStatus }))}
                        options={[
                          { value: 'active',             label: t('crm.pd.status.active') },
                          { value: 'under_construction', label: t('crm.pd.status.under_construction') },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Flächen + Etage */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.livingArea')}</label>
                      <input
                        type="number" min="0" step="0.01"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder={t('crm.pd.phLivingArea')}
                        value={form.size_sqm}
                        onChange={e => setForm(f => ({ ...f, size_sqm: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.terraceArea')}</label>
                      <input
                        type="number" min="0" step="0.01"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder={t('crm.pd.phTerrace')}
                        value={form.terrace_sqm}
                        onChange={e => setForm(f => ({ ...f, terrace_sqm: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unit.floor')}</label>
                      <input
                        type="number" min="0"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        placeholder={t('crm.pd.phFloor')}
                        value={form.floor}
                        onChange={e => setForm(f => ({ ...f, floor: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Zimmer */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.bedrooms')}</label>
                      <input
                        type="number" min="0"
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                        value={form.bedrooms}
                        onChange={e => setForm(f => ({ ...f, bedrooms: parseInt(e.target.value) || 0 }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.bathrooms')}</label>
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
                        <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.priceNet')}</label>
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
                        <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.priceGross')}</label>
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
                      <label className="text-xs text-gray-500 whitespace-nowrap">{t('crm.unitEdit.vat')}</label>
                      <input
                        type="number" min="0" max="100" step="0.5"
                        className="w-20 rounded-xl border border-gray-200 px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                        value={form.vat_rate}
                        onChange={e => handleVatChange(e.target.value)}
                      />
                      <span className="text-xs text-gray-400">
                        {t('crm.pd.netGrossHint')}
                      </span>
                    </div>
                  </div>

                  {/* Möblierung + Übergabe */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-2">{t('crm.pd.furnishing')}</label>
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
                            {v ? t('crm.unitEdit.furnished') : t('crm.pd.unfurnished')}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unitEdit.handoverDate')}</label>
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
                    <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.unit.notes')}</label>
                    <textarea
                      rows={2}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm resize-none focus:outline-none focus:border-[#ff795d]"
                      placeholder={t('crm.pd.notesPlaceholder')}
                      value={form.notes}
                      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    />
                  </div>

                  {/* ── Portal-Immobilie verknüpfen (nur bei bestehenden Einheiten) ── */}
                  {editUnit && (
                    <div className="border-t border-gray-100 pt-4">
                      <label className="block text-xs font-medium text-gray-500 mb-2">
                        {t('crm.pd.portalProperty')}
                      </label>
                      {editUnit.property_id ? (
                        <div className="flex items-center justify-between px-3 py-2
                                        bg-green-50 rounded-xl border border-green-100">
                          <span className="text-sm font-medium text-green-800 truncate">
                            {(() => {
                              const p = linkableProperties.find(lp => lp.id === editUnit.property_id)
                              return p
                                ? `${p.project_name}${p.unit_number ? ` · ${p.unit_number}` : ''}`
                                : t('crm.pd.linked')
                            })()}
                          </span>
                          <button
                            type="button"
                            disabled={linkPropSaving}
                            onClick={handleUnlinkProperty}
                            className="text-xs text-red-400 hover:text-red-600 disabled:opacity-40
                                       shrink-0 ml-2">
                            {t('crm.pd.unlink')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <CustomSelect
                            className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={linkPropId}
                            onChange={val => setLinkPropId(val)}
                            options={[
                              { value: '', label: t('crm.pd.selectProperty') },
                              ...linkableProperties.map(p => ({
                                value: p.id,
                                label: `${p.project_name}${p.unit_number ? ` · ${p.unit_number}` : ''}`,
                              })),
                            ]}
                            placeholder={t('crm.pd.selectProperty')}
                          />
                          <button
                            type="button"
                            disabled={!linkPropId || linkPropSaving}
                            onClick={handleLinkProperty}
                            className="shrink-0 px-3 py-2 rounded-xl text-sm font-medium
                                       text-white disabled:opacity-40 transition-opacity"
                            style={{ backgroundColor: 'var(--color-highlight)' }}>
                            {linkPropSaving ? '…' : t('crm.pd.link')}
                          </button>
                        </div>
                      )}
                      <p className="text-xs text-gray-400 mt-1.5">
                        {t('crm.pd.linkHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Bilder ───────────────────────────────────────────────────── */}
              {tab === 'bilder' && editUnit && (
                <div className="space-y-4">
                  {/* Upload button */}
                  <div>
                    <input
                      type="file"
                      ref={unitImgInputRef}
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={e => { if (e.target.files?.length) handleUploadUnitImages(e.target.files) }}
                    />
                    <button
                      onClick={() => unitImgInputRef.current?.click()}
                      disabled={uploadingUnitImg}
                      className="w-full border-2 border-dashed border-gray-200 rounded-xl py-6 text-sm text-gray-400
                                 hover:border-[#ff795d] hover:text-[#ff795d] transition-colors disabled:opacity-50"
                    >
                      {uploadingUnitImg ? t('crm.pd.uploading') : t('crm.pd.uploadImagesMulti')}
                    </button>
                  </div>

                  {/* Image grid */}
                  {unitImages.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">{t('crm.pd.noImages')}</p>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      {unitImages.map((url, idx) => (
                        <div key={url} className="relative group rounded-xl overflow-hidden aspect-video bg-gray-100">
                          <img src={url} alt={t('crm.pd.imageAlt', { n: idx + 1 })} className="w-full h-full object-cover" />
                          <button
                            onClick={() => handleDeleteUnitImage(url)}
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white text-xs
                                       flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                                       hover:bg-red-600"
                          >✕</button>
                          {idx === 0 && (
                            <span className="absolute bottom-1 left-1 text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded-full">
                              {t('crm.pd.coverImage')}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-400">{t('crm.pd.coverHint')}</p>
                </div>
              )}

              {/* ── Zahlungen ────────────────────────────────────────────────── */}
              {tab === 'zahlungen' && editUnit && (
                <div className="space-y-4">

                  {/* Summary */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-blue-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-blue-500 font-medium mb-0.5">{t('crm.pd.purchasePrice')}</p>
                      <p className="text-sm font-bold text-blue-800">{fmtPrice(totalPrice)}</p>
                    </div>
                    <div className="bg-green-50 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-green-500 font-medium mb-0.5">{t('crm.pd.paid')}</p>
                      <p className="text-sm font-bold text-green-800">{fmtPrice(totalPaid)}</p>
                    </div>
                    <div className={`rounded-xl p-3 text-center ${outstanding > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <p className={`text-[10px] font-medium mb-0.5 ${outstanding > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                        {t('crm.pd.outstanding')}
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
                    <p className="text-sm text-gray-400 text-center py-4">{t('crm.pd.noPayments')}</p>
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
                              {pay.due_date  ? `${t('crm.pd.due')}: ${fmtDate(pay.due_date)}` : ''}
                              {pay.paid_date ? ` · ${t('crm.pd.paid')}: ${fmtDate(pay.paid_date)}` : ''}
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
                      {editPayId ? t('crm.pd.editPayment') : t('crm.pd.addPayment')}
                    </p>
                    <input
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                      placeholder={t('crm.pd.paymentDescPlaceholder')}
                      value={payForm.description}
                      onChange={e => setPayForm(f => ({ ...f, description: e.target.value }))}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="number" min="0" step="100"
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder={t('crm.pd.amountPlaceholder')}
                        value={payForm.amount}
                        onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                      />
                      <input
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder={t('crm.pd.referencePlaceholder')}
                        value={payForm.payment_reference}
                        onChange={e => setPayForm(f => ({ ...f, payment_reference: e.target.value }))}
                      />
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1">{t('crm.pd.dueDate')}</label>
                        <input
                          type="date"
                          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                          value={payForm.due_date}
                          onChange={e => setPayForm(f => ({ ...f, due_date: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1">{t('crm.pd.paymentDate')}</label>
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
                        <span className="text-xs text-gray-600">{t('crm.pd.alreadyPaid')}</span>
                      </label>
                      <div className="flex gap-2 ml-auto">
                        {editPayId && (
                          <button
                            onClick={() => { setEditPayId(null); setPayForm({ ...EMPTY_PAY }) }}
                            className="px-3 py-2 text-xs text-gray-500 border border-gray-200 rounded-xl bg-white"
                          >
                            {t('common.cancel')}
                          </button>
                        )}
                        <button
                          onClick={handleSavePayment}
                          disabled={!payForm.amount || savingPay}
                          className="px-4 py-2 text-xs font-medium text-white rounded-xl disabled:opacity-50"
                          style={{ backgroundColor: '#ff795d' }}
                        >
                          {savingPay ? '…' : editPayId ? t('crm.pd.update') : t('crm.pd.add')}
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
                    <p className="text-xs font-semibold text-gray-500">{t('crm.pd.uploadDocument')}</p>

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
                        {t('crm.pd.chooseFile')}
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
                        placeholder={t('crm.pd.docNamePlaceholder')}
                        value={docForm.name}
                        onChange={e => setDocForm(d => ({ ...d, name: e.target.value }))}
                      />
                      <CustomSelect
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        value={docForm.doc_type}
                        onChange={val => setDocForm(d => ({
                          ...d, doc_type: val as CrmUnitDocument['doc_type'],
                        }))}
                        options={[
                          { value: 'kaufvertrag',   label: t('crm.pd.docType.kaufvertrag') },
                          { value: 'mietvertrag',   label: t('crm.pd.docType.mietvertrag') },
                          { value: 'rechnung',      label: t('crm.pd.docType.rechnung') },
                          { value: 'zahlungsbeleg', label: t('crm.pd.docType.zahlungsbeleg') },
                          { value: 'grundriss',     label: t('crm.pd.docType.grundriss') },
                          { value: 'sonstiges',     label: t('crm.pd.docType.sonstiges') },
                        ]}
                      />
                      <input
                        className="rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none"
                        placeholder={t('crm.pd.noteOptional')}
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
                      {uploadingDoc ? t('crm.pd.uploadingPlain') : t('crm.pd.upload')}
                    </button>
                  </div>

                  {/* Document list */}
                  {docLoading ? (
                    <div className="text-center py-6">
                      <span className="w-5 h-5 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin inline-block" />
                    </div>
                  ) : documents.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">{t('crm.pd.noDocuments')}</p>
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
                                {t(`crm.pd.docType.${doc.doc_type}`)}
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
                            {t('crm.pd.open')}
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
                        <p className="text-sm font-semibold text-gray-800">{t('crm.pd.handoverComplete')}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {t('crm.pd.handoverCompleteDesc')}
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
                      <p className="mt-2 text-xs text-green-600 font-medium">{t('crm.pd.markedComplete')}</p>
                    )}
                  </div>

                  {/* Verwalter */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.pd.assignManager')}</label>
                    <CustomSelect
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                      value={form.verwalter_id}
                      onChange={val => setForm(f => ({ ...f, verwalter_id: val }))}
                      options={[
                        { value: '', label: t('crm.pd.noManager') },
                        ...verwalters.map(v => ({ value: v.id, label: v.full_name })),
                      ]}
                      placeholder={t('crm.pd.noManager')}
                    />
                    {verwalters.length === 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        {t('crm.pd.noManagersHint')}
                      </p>
                    )}
                  </div>

                  {/* Miettyp */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-2">{t('crm.pd.rentalTypeLabel')}</label>
                    <div className="flex gap-3">
                      {([
                        { v: '',      label: t('crm.pd.rentalNotSet') },
                        { v: 'short', label: t('crm.pd.rentalShort')  },
                        { v: 'long',  label: t('crm.pd.rentalLong')  },
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

                  {/* Portal-Zugang */}
                  <div className="bg-blue-50 rounded-xl p-4 space-y-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{t('crm.pd.buyerPortalAccess')}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {t('crm.pd.portalAccessDesc')}
                      </p>
                    </div>
                    <input
                      className="w-full rounded-xl border border-blue-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                      placeholder={t('crm.pd.buyerEmailPlaceholder')}
                      type="email"
                      value={portalEmail}
                      onChange={e => setPortalEmail(e.target.value)}
                    />
                    <input
                      className="w-full rounded-xl border border-blue-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#ff795d]"
                      placeholder={t('crm.pd.fullNamePlaceholder')}
                      value={portalName}
                      onChange={e => setPortalName(e.target.value)}
                    />
                    {portalError && (
                      <p className="text-xs text-red-600">{portalError}</p>
                    )}
                    {portalSuccess && (
                      <p className="text-xs text-green-600 font-medium">
                        {t('crm.pd.accessSent')}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => sendPortalAccess(portalEmail, portalName)}
                      disabled={!portalEmail.trim() || !portalName.trim() || portalSending}
                      className="w-full py-2 text-xs font-medium text-white rounded-xl disabled:opacity-50"
                      style={{ backgroundColor: '#ff795d' }}
                    >
                      {portalSending ? t('crm.pd.sending') : t('crm.pd.createSendAccess')}
                    </button>
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
                    {t('crm.pd.deleteUnit')}
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
                >
                  {t('common.close')}
                </button>
                {(tab === 'grunddaten' || tab === 'verwaltung') && (
                  <button
                    onClick={handleSaveUnit}
                    disabled={!form.unit_number.trim() || saving}
                    className="px-5 py-2 text-sm font-medium text-white rounded-xl disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {saving ? t('common.saving') : editUnit ? t('crm.pd.update') : t('crm.pd.create')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Portal-Zugang Dialog (auto-shown when unit set to Verkauft)          */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {showPortalDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-2">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-3xl">🎉</span>
                <h2 className="text-lg font-bold text-gray-900">{t('crm.pd.unitSold')}</h2>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {t('crm.pd.portalDialogDesc')}
              </p>
            </div>

            <div className="px-6 py-4 space-y-3">
              <input
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:border-[#ff795d]"
                placeholder={t('crm.pd.buyerEmailPlaceholder')}
                type="email"
                value={portalEmail}
                onChange={e => setPortalEmail(e.target.value)}
              />
              <input
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:border-[#ff795d]"
                placeholder={t('crm.pd.fullNamePlaceholder')}
                value={portalName}
                onChange={e => setPortalName(e.target.value)}
              />
              {portalError && (
                <p className="text-xs text-red-600">{portalError}</p>
              )}
              {portalSuccess && (
                <p className="text-xs text-green-600 font-medium">
                  {t('crm.pd.accessSent')}
                </p>
              )}
            </div>

            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => {
                  setShowPortalDialog(false)
                  setPortalEmail('')
                  setPortalName('')
                  setPortalError('')
                  setPortalSuccess(false)
                }}
                className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
              >
                {t('crm.pd.later')}
              </button>
              <button
                onClick={async () => {
                  await sendPortalAccess(portalEmail, portalName)
                }}
                disabled={!portalEmail.trim() || !portalName.trim() || portalSending || portalSuccess}
                className="flex-1 py-2.5 text-sm font-medium text-white rounded-xl disabled:opacity-50"
                style={{ backgroundColor: '#ff795d' }}
              >
                {portalSending ? t('crm.pd.sending') : portalSuccess ? t('crm.pd.sent') : t('crm.pd.sendAccess')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Kunden-Zuweisungs-Modal ─────────────────────────────────────── */}
      {showAssignModal && assigningUnit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{t('crm.pd.assignCustomerTitle')}</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t('crm.pd.unitWord')} {assigningUnit.block ? t('projectDetail.blockPrefix', 'Block {{block}} · ', { block: assigningUnit.block }) : ''}{t('crm.unitSelect.no')} {assigningUnit.unit_number}
                </p>
              </div>
              <button
                onClick={() => { setShowAssignModal(false); setAssignLeadQuery(''); setAssignLeadResults([]) }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >✕</button>
            </div>

            <div className="px-6 py-4 space-y-3">
              {/* Search input */}
              <div className="relative">
                <input
                  type="text"
                  value={assignLeadQuery}
                  onChange={e => { setAssignLeadQuery(e.target.value); searchLeadsForAssign(e.target.value) }}
                  placeholder={t('crm.pd.searchNameEmail')}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm
                             focus:outline-none focus:border-[#ff795d] pr-8"
                  autoFocus
                />
                {assignLeadSearching && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4
                                   border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin" />
                )}
              </div>

              {/* Results */}
              {assignLeadResults.length > 0 && (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {assignLeadResults.map(lead => (
                    <button
                      key={lead.id}
                      onClick={() => handleAssignLeadToUnit(lead.id, lead.deal_id)}
                      disabled={assignLeadSaving}
                      className="w-full text-left border border-gray-100 rounded-xl px-4 py-3
                                 hover:border-[#ff795d] hover:bg-orange-50 transition-colors
                                 disabled:opacity-50"
                    >
                      <div className="font-medium text-gray-900 text-sm">
                        {lead.first_name} {lead.last_name}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                        <span>{lead.email}</span>
                        {!lead.deal_id && (
                          <span className="text-yellow-600 font-medium">{t('crm.pd.noActiveDeal')}</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {assignLeadQuery.length >= 2 && !assignLeadSearching && assignLeadResults.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">
                  {t('crm.pd.noLeadsFound')}
                </p>
              )}

              {assignLeadQuery.length < 2 && (
                <p className="text-xs text-gray-400 text-center py-2">
                  {t('crm.pd.minTwoChars')}
                </p>
              )}
            </div>

            <div className="px-6 pb-5">
              <button
                onClick={() => { setShowAssignModal(false); setAssignLeadQuery(''); setAssignLeadResults([]) }}
                className="w-full py-2.5 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50"
              >
                {t('crm.pd.assignLater')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rechtsklick-Kontextmenü auf einer Unit-Kachel */}
      {unitCtx && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setUnitCtx(null)}
            onContextMenu={(e) => { e.preventDefault(); setUnitCtx(null) }} />
          <div className="fixed z-[61] bg-white rounded-xl shadow-2xl border border-gray-100 py-1 min-w-[170px]"
            style={{ top: unitCtx.y, left: unitCtx.x }}>
            <button onClick={() => deleteUnit(unitCtx.unit)}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
              🗑 {t('crm.pd.unitDelete', 'Einheit löschen')} · {unitCtx.unit.unit_number}
            </button>
          </div>
        </>
      )}
    </DashboardLayout>
  )
}
