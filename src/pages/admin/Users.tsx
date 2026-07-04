import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import type { CrmProject, CrmProjectUnit } from '../../lib/crmTypes'
import { CustomSelect } from '../../components/CustomSelect'
import { renderPortalAccessEmail } from '../../lib/welcomeEmail'

// Hilfsfunktion: alle Admin-Operationen laufen als Edge Function (kein Service-Key im Browser)
async function adminUserOp<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin-user-ops', { body })
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
  return data as T
}

// ── Types ──────────────────────────────────────────────────────
type Role = 'admin' | 'verwalter' | 'eigentuemer' | 'feriengast'
type Lang = 'de' | 'en'

interface UserProfile {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: Role
  language: Lang
  address_street: string | null
  address_zip: string | null
  address_city: string | null
  address_country: string | null
  iban: string | null
  bic: string | null
  bank_account_holder: string | null
  is_active: boolean
  created_at: string
}

interface Property {
  id:                   string
  project_name:         string
  unit_number:          string | null
  owner_id:             string
  type:                 'apartment' | 'villa' | 'studio' | null
  bedrooms:             number | null
  size_sqm:             number | null
  purchase_price_gross: number | null
  property_status:      'active' | 'under_construction' | null
}

interface VerwaltungOption { id: string; name: string }

interface FormState {
  firstName: string
  lastName: string
  email: string
  role: Role
  phone: string
  language: Lang
  address_street: string
  iban: string
  bic: string
  bank_account_holder: string
  address_zip: string
  address_city: string
  address_country: string
  tempPassword: string
  showPassword: boolean
  verwaltung_id: string
}

// ── Helpers ────────────────────────────────────────────────────
function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  return Array.from(crypto.getRandomValues(new Uint8Array(14)))
    .map(b => chars[b % chars.length])
    .join('')
}

function emptyForm(): FormState {
  return {
    firstName:           '',
    lastName:            '',
    email:               '',
    role:                'eigentuemer',
    phone:               '',
    language:            'de',
    address_street:      '',
    address_zip:         '',
    address_city:        '',
    address_country:     'Deutschland',
    iban:                '',
    bic:                 '',
    bank_account_holder: '',
    tempPassword:        generatePassword(),
    showPassword:        false,
    verwaltung_id:       '',
  }
}

function maskIban(iban: string): string {
  const clean = iban.replace(/\s/g, '')
  if (clean.length < 6) return iban
  const start = clean.slice(0, 4)
  const end   = clean.slice(-2)
  const stars = '*'.repeat(Math.max(0, clean.length - 6))
  const raw = `${start}${stars}${end}`
  return raw.match(/.{1,4}/g)?.join(' ') ?? raw
}

// ── Role Badge ─────────────────────────────────────────────────
function RoleBadge({ role }: { role: Role }) {
  const colors: Record<Role, string> = {
    admin:       'bg-purple-100 text-purple-700',
    verwalter:   'bg-blue-100   text-blue-700',
    eigentuemer: 'bg-green-100  text-green-700',
    feriengast:  'bg-amber-100  text-amber-700',
  }
  const { t } = useTranslation()
  return (
    <span className={`text-xs font-semibold font-body px-2.5 py-1 rounded-full ${colors[role]}`}>
      {t(`roles.${role}`)}
    </span>
  )
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className="fixed bottom-6 right-6 z-50 px-5 py-3 bg-hp-black text-white text-sm
                    font-body rounded-2xl shadow-xl flex items-center gap-3 animate-slide-up">
      <span>✓</span> {msg}
      <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100">✕</button>
    </div>
  )
}

// ── Field ──────────────────────────────────────────────────────
function Field({
  label, required, children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 font-body mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const inputCls = `w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm
  font-body text-hp-black placeholder-gray-300 focus:outline-none
  focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition`

// ══════════════════════════════════════════════════════════════
// AdminUsers
// ══════════════════════════════════════════════════════════════
export default function AdminUsers() {
  const { t }        = useTranslation()
  const { profile }  = useAuth()
  const navigate     = useNavigate()

  // ── State ────────────────────────────────────────────────
  const [users, setUsers]           = useState<UserProfile[]>([])
  const [allProps, setAllProps]     = useState<Property[]>([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [modal, setModal]           = useState<'new' | 'edit' | null>(null)
  const [editUser, setEditUser]     = useState<UserProfile | null>(null)
  const [form, setForm]             = useState<FormState>(emptyForm())
  const [saving, setSaving]         = useState(false)
  const [formError, setFormError]   = useState('')
  const [toast, setToast]           = useState<string | null>(null)
  const [assignPropId, setAssignPropId] = useState('')
  const toastCb = useCallback(() => setToast(null), [])
  const [verwaltungOptions, setVerwaltungOptions] = useState<VerwaltungOption[]>([])

  // ── Delete state ─────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<UserProfile | null>(null)
  const [deleting, setDeleting]         = useState(false)

  // ── Passwort-Anzeige nach Anlegen / Reset ─────────────────
  const [createdPassword, setCreatedPassword] = useState<string | null>(null)
  const [pwEmailed, setPwEmailed]             = useState(false)
  const [pwCopied, setPwCopied]               = useState(false)

  // ── Lead-ID-Map für CRM-Link (email → lead_id) ───────────
  const [leadIdMap, setLeadIdMap] = useState<Record<string, string>>({})
  const [resetingPwId, setResetingPwId] = useState<string | null>(null)

  // ── Wohnungszuweisung beim Erstellen ─────────────────────────────
  const [crmProjects,     setCrmProjects]     = useState<CrmProject[]>([])
  const [assignProjectId, setAssignProjectId] = useState('')
  const [projectUnits,    setProjectUnits]    = useState<CrmProjectUnit[]>([])
  const [loadingUnits,    setLoadingUnits]    = useState(false)
  const [assignUnitId,    setAssignUnitId]    = useState('') // '' = keine, 'new' = neu anlegen
  const [newUnitForm,     setNewUnitForm]     = useState({
    unit_number: '', type: 'apartment' as 'apartment' | 'villa' | 'studio',
    bedrooms: 1, size_sqm: '', price_net: '', price_gross: '',
  })

  function copyCreatedPw() {
    if (!createdPassword) return
    navigator.clipboard.writeText(createdPassword)
    setPwCopied(true)
    setTimeout(() => setPwCopied(false), 2000)
  }

  // ── Fetch ────────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      // Profile sofort laden und anzeigen
      const { data: profileData } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, role, language, address_street, address_zip, address_city, address_country, iban, bic, bank_account_holder, is_active, created_at')
        .order('created_at', { ascending: false })
        .limit(500)

      const profiles = (profileData as UserProfile[]) ?? []
      setUsers(profiles)  // sofort anzeigen, nicht auf Edge Function warten

      // Verwaiste Profile im Hintergrund bereinigen (non-blocking)
      adminUserOp<{ ids: string[] }>({ action: 'list_auth_ids' })
        .then(({ ids }) => {
          const authIds  = new Set(ids)
          const orphaned = profiles.filter(p => !authIds.has(p.id))
          if (orphaned.length > 0) {
            Promise.all(
              orphaned.map(p => adminUserOp({ action: 'delete_profile', profileId: p.id }))
            ).then(() => {
              setUsers(profiles.filter(p => authIds.has(p.id)))
            }).catch(() => {})
          }
        })
        .catch(() => {}) // Edge Function nicht erreichbar → ignorieren
    } catch (e) {
      console.error('[fetchUsers]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchProps = useCallback(async () => {
    const { data } = await supabase
      .from('properties')
      .select('id, project_name, unit_number, owner_id, type, bedrooms, size_sqm, purchase_price_gross, property_status')
      .order('project_name')
    setAllProps((data as Property[]) ?? [])
  }, [])

  const fetchVerwaltungen = useCallback(async () => {
    const { data } = await supabase.from('verwaltungen').select('id, name').order('name')
    setVerwaltungOptions((data as VerwaltungOption[]) ?? [])
  }, [])

  const fetchCrmProjects = useCallback(async () => {
    const { data } = await supabase
      .from('crm_projects')
      .select('id, name, location, status, images, description_de, description_en, developer, completion_date, video_url, equipment_list, latitude, longitude, created_at, updated_at')
      .order('name')
    setCrmProjects((data ?? []) as CrmProject[])
  }, [])

  async function fetchProjectUnits(projectId: string) {
    setLoadingUnits(true)
    try {
      const { data } = await supabase
        .from('crm_project_units')
        .select('*')
        .eq('project_id', projectId)
        .order('block', { ascending: true, nullsFirst: true })
        .order('unit_number', { ascending: true })
      setProjectUnits((data ?? []) as CrmProjectUnit[])
    } finally {
      setLoadingUnits(false)
    }
  }

  useEffect(() => {
    fetchUsers()
    fetchProps()
    fetchVerwaltungen()
    fetchCrmProjects()   // ← neu
    // Lead-ID-Map: email → lead_id (für CRM-Link bei Eigentümern)
    supabase.from('leads').select('id, email').limit(1000).then(({ data }) => {
      if (data) {
        const map: Record<string, string> = {}
        for (const l of data as { id: string; email: string }[]) {
          map[l.email.toLowerCase()] = l.id
        }
        setLeadIdMap(map)
      }
    })
  }, [fetchUsers, fetchProps, fetchVerwaltungen, fetchCrmProjects])

  // ── Filter ───────────────────────────────────────────────
  const filtered = users.filter(u => {
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    const q = search.toLowerCase()
    const matchSearch = !q || u.full_name.toLowerCase().includes(q) ||
                        u.email.toLowerCase().includes(q)
    return matchRole && matchSearch
  })

  // ── Open modals ──────────────────────────────────────────
  function openNew() {
    setForm(emptyForm())
    setFormError('')
    setEditUser(null)
    setAssignPropId('')
    setAssignProjectId('')   // ← neu
    setAssignUnitId('')      // ← neu
    setProjectUnits([])      // ← neu
    setNewUnitForm({ unit_number: '', type: 'apartment', bedrooms: 1, size_sqm: '', price_net: '', price_gross: '' })  // ← neu
    setModal('new')
  }

  function openEdit(u: UserProfile) {
    const parts = u.full_name.split(' ')
    setForm({
      firstName:           parts[0] ?? '',
      lastName:            parts.slice(1).join(' '),
      email:               u.email,
      role:                u.role,
      phone:               u.phone ?? '',
      language:            u.language,
      address_street:      u.address_street ?? '',
      address_zip:         u.address_zip ?? '',
      address_city:        u.address_city ?? '',
      address_country:     u.address_country ?? 'Deutschland',
      iban:                u.iban ?? '',
      bic:                 u.bic ?? '',
      bank_account_holder: u.bank_account_holder ?? '',
      tempPassword:        generatePassword(),
      showPassword:        false,
      verwaltung_id:       (u as UserProfile & { verwaltung_id?: string }).verwaltung_id ?? '',
    })
    setFormError('')
    setEditUser(u)
    setAssignPropId('')
    setModal('edit')
  }

  function closeModal() { setModal(null); setEditUser(null); setFormError('') }

  // ── Derived form value ───────────────────────────────────
  function setF<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  // ── Validate ─────────────────────────────────────────────
  function validate(): string {
    if (!form.firstName.trim()) return t('users.errors.firstNameRequired')
    if (!form.lastName.trim())  return t('users.errors.lastNameRequired')
    if (!form.email.trim())     return t('users.errors.emailRequired')
    return ''
  }

  // ── Wohnungseinheit für neuen User anlegen/verknüpfen ───────────────────────────────
  async function performUnitAssignment(userId: string, userEmail: string) {
    if (!assignProjectId || !assignUnitId) return
    const project = crmProjects.find(p => p.id === assignProjectId)
    if (!project) return

    let unit: CrmProjectUnit | null = null

    if (assignUnitId === 'new') {
      if (!newUnitForm.unit_number.trim()) return
      const { data: newUnit, error } = await supabase
        .from('crm_project_units')
        .insert({
          project_id:   assignProjectId,
          unit_number:  newUnitForm.unit_number.trim(),
          type:         newUnitForm.type,
          bedrooms:     newUnitForm.bedrooms,
          bathrooms:    1,
          size_sqm:     newUnitForm.size_sqm   ? parseFloat(newUnitForm.size_sqm)   : null,
          price_net:    newUnitForm.price_net   ? parseFloat(newUnitForm.price_net)   : null,
          price_gross:  newUnitForm.price_gross ? parseFloat(newUnitForm.price_gross) : null,
          vat_rate:     5,
          status:       'active' as const,
          is_furnished: false,
          is_completed: false,
          images:       [] as string[],
        })
        .select()
        .single()
      if (error || !newUnit) return
      unit = newUnit as CrmProjectUnit
    } else {
      unit = projectUnits.find(u => u.id === assignUnitId) ?? null
    }
    if (!unit) return

    // Property anlegen
    const rentalType: 'longterm' | 'shortterm' =
      unit.rental_type === 'short' ? 'shortterm' : 'longterm'
    const { data: newProp, error: propErr } = await supabase
      .from('properties')
      .insert({
        owner_id:             userId,
        project_name:         project.name,
        unit_number:          unit.unit_number || null,
        type:                 (unit.type ?? 'apartment') as 'villa' | 'apartment' | 'studio',
        bedrooms:             unit.bedrooms ?? 0,
        size_sqm:             unit.size_sqm ?? null,
        is_furnished:         unit.is_furnished ?? false,
        rental_type:          rentalType,
        city:                 project.location ?? null,
        purchase_price_net:   unit.price_net ?? null,
        purchase_price_gross: unit.price_gross ?? null,
        property_status:      unit.status === 'under_construction' ? 'under_construction' : 'active',
        images:               [] as string[],
        created_by:           profile!.id,
      })
      .select('id')
      .single()
    if (propErr || !newProp) return
    const newPropId = (newProp as { id: string }).id

    // Unit mit Property verknüpfen
    await supabase.from('crm_project_units').update({ property_id: newPropId }).eq('id', unit.id)

    // Lead-Deal aktualisieren falls vorhanden
    const { data: leadRow } = await supabase
      .from('leads').select('id').eq('email', userEmail).maybeSingle()
    if (leadRow) {
      const { data: dealRow } = await supabase
        .from('deals').select('id').eq('lead_id', (leadRow as { id: string }).id)
        .neq('phase', 'archiviert').maybeSingle()
      if (dealRow) {
        await supabase.from('deals').update({ unit_id: unit.id, property_id: newPropId })
          .eq('id', (dealRow as { id: string }).id)
      }
    }
  }

  // ── Create user ──────────────────────────────────────────
  // Läuft via Edge Function – kein Service-Key im Browser nötig.
  // Passwort wird generiert und dem Admin angezeigt (kein automatischer E-Mail-Versand).
  async function handleCreate() {
    const err = validate()
    if (err) { setFormError(err); return }
    setSaving(true)
    setFormError('')
    try {
      const full_name = `${form.firstName.trim()} ${form.lastName.trim()}`
      const result = await adminUserOp<{ success: true; userId: string; password: string }>({
        action:              'create',
        email:               form.email.trim(),
        full_name,
        role:                form.role,
        language:            form.language,
        phone:               form.phone.trim() || null,
        address_street:      form.address_street.trim() || null,
        address_zip:         form.address_zip.trim() || null,
        address_city:        form.address_city.trim() || null,
        address_country:     form.address_country.trim() || null,
        iban:                form.iban.trim() || null,
        bic:                 form.bic.trim() || null,
        bank_account_holder: form.bank_account_holder.trim() || null,
      })
      // Wohnung zuweisen falls ausgewählt
      if (form.role === 'eigentuemer' && assignProjectId && assignUnitId) {
        await performUnitAssignment(result.userId, form.email.trim())
      }
      // Willkommens-E-Mail mit Zugangsdaten automatisch senden
      const { subject: welcomeSubject, html: welcomeHtml } = await renderPortalAccessEmail(
        form.firstName.trim(),
        form.email.trim(),
        result.password,
      )
      supabase.functions.invoke('send-email', {
        body: {
          to:      form.email.trim(),
          subject: welcomeSubject,
          html:    welcomeHtml,
        },
      }).catch(() => { /* Fehler im Hintergrund ignorieren */ })
      closeModal()
      setToast(`✉️ ${t('users.toast.createdCredentialsSent', 'Nutzer angelegt – Zugangsdaten wurden an {{email}} gesendet.', { email: form.email.trim() })}`)
      fetchUsers()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ── Update user ──────────────────────────────────────────
  async function handleUpdate() {
    if (!editUser) return
    const err = validate()
    if (err) { setFormError(err); return }
    setSaving(true)
    setFormError('')
    try {
      const full_name = `${form.firstName.trim()} ${form.lastName.trim()}`
      const { error } = await supabase.from('profiles').update({
        full_name,
        phone:           form.phone.trim() || null,
        role:            form.role,
        language:        form.language,
        address_street:  form.address_street.trim() || null,
        address_zip:     form.address_zip.trim() || null,
        address_city:    form.address_city.trim() || null,
        address_country:     form.address_country.trim() || null,
        iban:                form.iban.trim() || null,
        bic:                 form.bic.trim() || null,
        bank_account_holder: form.bank_account_holder.trim() || null,
        verwaltung_id:       form.role === 'verwalter' ? (form.verwaltung_id || null) : null,
      }).eq('id', editUser.id)
      if (error) throw new Error(error.message)
      closeModal()
      setToast(t('users.success.updated'))
      fetchUsers()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ── Reset password ───────────────────────────────────────
  async function handleResetPassword() {
    if (!editUser) return
    setSaving(true)
    setFormError('')
    try {
      const { password, emailed } = await adminUserOp<{ success: true; password: string; emailed: boolean }>({
        action: 'reset_password',
        userId: editUser.id,
        sendEmail: true,
      })
      closeModal()
      setPwEmailed(!!emailed)
      setCreatedPassword(password)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ── Toggle active ────────────────────────────────────────
  async function handleToggleActive(u: UserProfile) {
    const next = !u.is_active
    const { error } = await supabase
      .from('profiles')
      .update({ is_active: next })
      .eq('id', u.id)
    if (!error) {
      setToast(next ? t('users.success.activated') : t('users.success.deactivated'))
      fetchUsers()
    }
  }

  // ── Delete user ──────────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return

    // Hard-Guard: Selbst-Löschung niemals zulassen (UI-unabhängig)
    if (deleteTarget.id === profile?.id) return

    // Hard-Guard: Letzten Admin nicht löschen
    const adminCount = users.filter(u => u.role === 'admin').length
    if (deleteTarget.role === 'admin' && adminCount <= 1) return

    setDeleting(true)
    try {
      await adminUserOp({ action: 'delete_user', userId: deleteTarget.id })
      setDeleteTarget(null)
      setToast(t('users.success.deleted'))
      fetchUsers()
      fetchProps()
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('errors.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  // ── Quick portal password reset (direkt aus Tabelle) ────────
  async function handleQuickResetPassword(u: UserProfile) {
    if (!window.confirm(t('users.confirm.quickResetPassword', 'Neues Passwort für {{name}} generieren und dem Nutzer per E-Mail senden?', { name: u.full_name }))) return
    setResetingPwId(u.id)
    try {
      const { password, emailed } = await adminUserOp<{ success: true; password: string; emailed: boolean }>({
        action: 'reset_password',
        userId: u.id,
        sendEmail: true,
      })
      setPwEmailed(!!emailed)
      setCreatedPassword(password)
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('users.errors.resetFailed', 'Fehler beim Zurücksetzen'))
    } finally {
      setResetingPwId(null)
    }
  }

  // ── Assign property to owner ─────────────────────────────
  async function handleAssignProperty() {
    if (!editUser || !assignPropId) return
    setSaving(true)
    const { error } = await supabase
      .from('properties')
      .update({ owner_id: editUser.id })
      .eq('id', assignPropId)
    if (!error) {
      setToast(t('users.properties.assigned'))
      setAssignPropId('')
      fetchProps()
    }
    setSaving(false)
  }

  // ── Remove property from owner ───────────────────────────
  async function handleRemoveProperty(propId: string, newOwnerId: string) {
    setSaving(true)
    await supabase.from('properties').update({ owner_id: newOwnerId }).eq('id', propId)
    fetchProps()
    setSaving(false)
  }

  // ── Properties for the edited owner ─────────────────────
  const ownerProps = editUser
    ? allProps.filter(p => p.owner_id === editUser.id)
    : []
  const unassignedProps = allProps.filter(p => editUser && p.owner_id !== editUser.id)


  // ── Role filter tabs ─────────────────────────────────────
  const roleTabs = [
    { key: 'all',         label: t('users.filter.all') },
    { key: 'admin',       label: t('roles.admin') },
    { key: 'eigentuemer', label: t('roles.eigentuemer') },
    { key: 'feriengast',  label: t('roles.feriengast') },
  ]

  // ════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════
  return (
    <DashboardLayout basePath="/admin/dashboard">
      {toast && <Toast msg={toast} onClose={toastCb} />}

      {/* ── Passwort-Anzeige nach Anlegen / Reset ────────────── */}
      {createdPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="text-center mb-5">
              <div className="text-4xl mb-3">✅</div>
              <h2 className="text-lg font-bold text-hp-black font-body">{t('users.passwordModal.title', 'Passwort zurückgesetzt')}</h2>
              <p className="text-sm text-gray-500 font-body mt-1">
                {pwEmailed
                  ? `✉️ ${t('users.passwordModal.emailedNote', 'Die Zugangsdaten wurden dem Nutzer per E-Mail gesendet. Passwort unten als Kopie.')}`
                  : t('users.passwordModal.manualNote', 'Bitte Passwort manuell mitteilen (per WhatsApp, Telefon o.ä.)')}
              </p>
            </div>
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-4">
              <p className="text-xs text-gray-400 font-body mb-1">{t('users.passwordModal.generatedLabel', 'Generiertes Passwort')}</p>
              <p className="font-mono text-lg font-bold text-hp-black tracking-wider text-center">
                {createdPassword}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={copyCreatedPw}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm
                           font-semibold font-body text-gray-700 hover:border-gray-300
                           transition-colors">
                {pwCopied ? `✓ ${t('users.passwordModal.copied', 'Kopiert!')}` : `📋 ${t('users.passwordModal.copy', 'Kopieren')}`}
              </button>
              <button
                onClick={() => { setCreatedPassword(null); setPwCopied(false); setPwEmailed(false) }}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                           font-body transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {t('users.passwordModal.done', 'Fertig')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-hp-black"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('users.title')}
          </h1>
          <p className="text-sm text-gray-400 font-body mt-0.5">
            {users.length} {t('users.total')}
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm
                     font-semibold font-body transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--color-highlight)' }}>
          <span className="text-lg leading-none">+</span>
          {t('users.newUser')}
        </button>
      </div>

      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="text"
          placeholder={t('users.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={`${inputCls} sm:max-w-xs`}
        />
        <div className="flex gap-1 flex-wrap">
          {roleTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setRoleFilter(tab.key)}
              className={`px-3 py-1.5 rounded-xl text-sm font-body font-medium transition-colors
                ${roleFilter === tab.key
                  ? 'bg-hp-black text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 font-body text-sm">
            <div className="w-6 h-6 border-2 rounded-full animate-spin mr-3"
                 style={{ borderColor: '#e5e7eb', borderTopColor: 'var(--color-highlight)' }} />
            {t('common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400 font-body text-sm">
            {t('users.noResults')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wider">
                  <th className="text-left px-5 py-3">{t('users.table.name')}</th>
                  <th className="text-left px-5 py-3">{t('users.table.email')}</th>
                  <th className="text-left px-5 py-3">{t('users.table.role')}</th>
                  <th className="text-left px-5 py-3 hidden md:table-cell">{t('users.table.phone')}</th>
                  <th className="text-left px-5 py-3">{t('users.table.status')}</th>
                  <th className="text-left px-5 py-3 hidden lg:table-cell">{t('users.table.created')}</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, i) => (
                  <tr key={u.id}
                      onClick={() => openEdit(u)}
                      className={`border-b border-gray-50 hover:bg-gray-50/70 transition-colors cursor-pointer
                        ${i === filtered.length - 1 ? 'border-b-0' : ''}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        {/* Avatar */}
                        <div className="w-8 h-8 rounded-full flex items-center justify-center
                                        text-xs font-bold text-white shrink-0"
                             style={{ backgroundColor: u.is_active ? 'var(--color-highlight)' : '#d1d5db' }}>
                          {u.full_name.charAt(0).toUpperCase() || '?'}
                        </div>
                        <span className={`font-medium ${!u.is_active ? 'text-gray-400 line-through' : 'text-hp-black'}`}>
                          {u.full_name || '–'}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-gray-500">{u.email}</td>
                    <td className="px-5 py-3"><RoleBadge role={u.role} /></td>
                    <td className="px-5 py-3 text-gray-500 hidden md:table-cell">
                      {u.phone || '–'}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full
                        ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {u.is_active ? t('users.status.active') : t('users.status.inactive')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-400 text-xs hidden lg:table-cell">
                      {new Date(u.created_at).toLocaleDateString('de-DE')}
                    </td>
                    <td className="px-5 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        {/* CRM-Link für Eigentümer */}
                        {u.role === 'eigentuemer' && leadIdMap[u.email.toLowerCase()] && (
                          <button
                            onClick={() => navigate(`/admin/crm/leads/${leadIdMap[u.email.toLowerCase()]}`)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg border
                                       border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors">
                            🏠 CRM
                          </button>
                        )}
                        {/* Portal-Zugang zurücksetzen */}
                        {u.role === 'eigentuemer' && (
                          <button
                            onClick={() => handleQuickResetPassword(u)}
                            disabled={resetingPwId === u.id}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg border
                                       border-green-200 text-green-700 hover:bg-green-50
                                       transition-colors disabled:opacity-50">
                            {resetingPwId === u.id ? '⏳' : '🔑 Neues PW'}
                          </button>
                        )}
                        <button
                          onClick={() => openEdit(u)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border
                                     border-gray-200 text-gray-600 hover:border-gray-300
                                     hover:text-hp-black transition-colors">
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => handleToggleActive(u)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                            ${u.is_active
                              ? 'border-orange-100 text-orange-500 hover:bg-orange-50'
                              : 'border-green-100 text-green-600 hover:bg-green-50'}`}>
                          {u.is_active ? t('users.actions.deactivate') : t('users.actions.activate')}
                        </button>
                        {/* Löschen: sichtbar für Admins */}
                        {profile?.role === 'admin' && (() => {
                          const isSelf      = u.id === profile?.id
                          const adminCount  = users.filter(x => x.role === 'admin').length
                          const isLastAdmin = u.role === 'admin' && adminCount <= 1
                          const propCount   = allProps.filter(p => p.owner_id === u.id).length
                          const blocked     = isSelf || isLastAdmin || propCount > 0
                          const tooltip     = isSelf
                            ? t('users.delete.cannotSelf')
                            : isLastAdmin
                              ? t('users.delete.lastAdmin')
                              : propCount > 0
                                ? t('users.delete.hasProperties', { count: propCount })
                                : undefined
                          return (
                            <button
                              onClick={() => setDeleteTarget(u)}
                              title={tooltip}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                                ${blocked
                                  ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                                  : 'border-red-200 text-red-500 hover:bg-red-50'}`}>
                              {t('common.delete')}
                            </button>
                          )
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modal ──────────────────────────────────────────── */}
      {modal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center
                        bg-black/40 backdrop-blur-sm overflow-y-auto py-8 px-4"
             onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl my-auto">

            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
              <h2 className="text-lg font-bold text-hp-black"
                  style={{ fontFamily: 'var(--font-heading)' }}>
                {modal === 'new' ? t('users.newUser') : t('users.editUser')}
              </h2>
              <button onClick={closeModal}
                      className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            <div className="px-6 py-5 space-y-6 max-h-[75vh] overflow-y-auto">

              {/* ── Stammdaten ────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                               font-body mb-3">{t('users.sections.master')}</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('users.form.firstName')} required>
                    <input className={inputCls} value={form.firstName}
                           onChange={e => setF('firstName', e.target.value)}
                           placeholder="Max" />
                  </Field>
                  <Field label={t('users.form.lastName')} required>
                    <input className={inputCls} value={form.lastName}
                           onChange={e => setF('lastName', e.target.value)}
                           placeholder="Mustermann" />
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3">
                  <Field label={t('users.form.email')} required>
                    <input className={inputCls} type="email" value={form.email}
                           disabled={modal === 'edit'}
                           onChange={e => setF('email', e.target.value)}
                           placeholder="max@example.com" />
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Field label={t('users.form.role')} required>
                    <CustomSelect
                      className={inputCls}
                      value={form.role}
                      onChange={val => setF('role', val as Role)}
                      options={[
                        { value: 'admin',       label: t('roles.admin') },
                        { value: 'verwalter',   label: t('roles.verwalter') },
                        { value: 'eigentuemer', label: t('roles.eigentuemer') },
                        { value: 'feriengast',  label: t('roles.feriengast') },
                      ]}
                    />
                  </Field>
                  <Field label={t('users.form.phone')}>
                    <input className={inputCls} value={form.phone}
                           onChange={e => setF('phone', e.target.value)}
                           placeholder="+49 170 …" />
                  </Field>
                  <Field label={t('users.form.language')}>
                    <CustomSelect
                      className={inputCls}
                      value={form.language}
                      onChange={val => setF('language', val as Lang)}
                      options={[
                        { value: 'de', label: '🇩🇪 Deutsch' },
                        { value: 'en', label: '🇬🇧 English' },
                      ]}
                    />
                  </Field>
                </div>
              </section>

              {/* ── Wohnung zuweisen (nur beim Erstellen, Rolle Eigentümer) ─── */}
              {modal === 'new' && form.role === 'eigentuemer' && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
                    🏠 {t('users.unitAssign.heading', 'Wohnung zuweisen (optional)')}
                  </h3>

                  {/* Projekt */}
                  <Field label={t('users.unitAssign.project', 'Projekt')}>
                    <CustomSelect
                      className={inputCls}
                      value={assignProjectId}
                      onChange={val => {
                        setAssignProjectId(val)
                        setAssignUnitId('')
                        if (val) fetchProjectUnits(val)
                        else setProjectUnits([])
                      }}
                      options={[
                        { value: '', label: t('users.unitAssign.noProject', '— Kein Projekt —') },
                        ...crmProjects.map(p => ({ value: p.id, label: p.name })),
                      ]}
                      placeholder={t('users.unitAssign.noProject', '— Kein Projekt —')}
                    />
                  </Field>

                  {/* Einheit */}
                  {assignProjectId && (
                    <div className="mt-3">
                      <Field label={t('users.unitAssign.unit', 'Wohnungseinheit')}>
                        {loadingUnits ? (
                          <div className="flex items-center gap-2 py-2">
                            <span className="w-4 h-4 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin inline-block" />
                            <span className="text-xs text-gray-400 font-body">{t('users.unitAssign.loadingUnits', 'Lade Wohnungen…')}</span>
                          </div>
                        ) : (
                          <CustomSelect
                            className={inputCls}
                            value={assignUnitId}
                            onChange={val => setAssignUnitId(val)}
                            options={[
                              { value: '', label: t('users.unitAssign.noUnit', '— Keine Einheit —') },
                              ...projectUnits
                                .filter(u => !u.property_id)
                                .map(u => ({
                                  value: u.id,
                                  label: `${u.block ? `${t('users.unitAssign.block', 'Block')} ${u.block} · ` : ''}${u.unit_number}${u.type === 'villa' ? ' · Villa' : u.type === 'studio' ? ' · Studio' : ''}${u.bedrooms ? ` · ${u.bedrooms} ${t('users.unitAssign.bedroomsAbbr', 'SZ')}` : ''}${u.size_sqm ? ` · ${u.size_sqm} m²` : ''}`,
                                })),
                              { value: 'new', label: t('users.unitAssign.createNew', '+ Neue Wohnung anlegen') },
                            ]}
                            placeholder={t('users.unitAssign.noUnit', '— Keine Einheit —')}
                          />
                        )}
                      </Field>
                    </div>
                  )}

                  {/* Neue Wohnung anlegen — Mini-Formular */}
                  {assignUnitId === 'new' && (
                    <div className="mt-3 p-4 bg-gray-50 rounded-xl space-y-3 border border-gray-100">
                      <p className="text-xs font-semibold text-gray-500 font-body">{t('users.unitAssign.newUnitLabel', 'Neue Wohnung')}</p>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t('users.unitAssign.unitNumber', 'Wohnungsnummer *')}>
                          <input
                            className={inputCls}
                            placeholder={t('users.unitAssign.unitNumberPlaceholder', 'z.B. 12 oder A-12')}
                            value={newUnitForm.unit_number}
                            onChange={e => setNewUnitForm(f => ({ ...f, unit_number: e.target.value }))}
                          />
                        </Field>
                        <Field label={t('users.unitAssign.type', 'Typ')}>
                          <CustomSelect
                            className={inputCls}
                            value={newUnitForm.type}
                            onChange={val => setNewUnitForm(f => ({ ...f, type: val as 'apartment' | 'villa' | 'studio' }))}
                            options={[
                              { value: 'apartment', label: t('users.unitAssign.typeApartment', 'Wohnung') },
                              { value: 'villa',     label: 'Villa' },
                              { value: 'studio',    label: 'Studio' },
                            ]}
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <Field label={t('users.unitAssign.bedrooms', 'Schlafzimmer')}>
                          <input
                            className={inputCls}
                            type="number" min="0"
                            value={newUnitForm.bedrooms}
                            onChange={e => setNewUnitForm(f => ({ ...f, bedrooms: parseInt(e.target.value) || 0 }))}
                          />
                        </Field>
                        <Field label={t('users.unitAssign.size', 'Fläche (m²)')}>
                          <input
                            className={inputCls}
                            type="number" min="0" step="0.01"
                            placeholder="85"
                            value={newUnitForm.size_sqm}
                            onChange={e => setNewUnitForm(f => ({ ...f, size_sqm: e.target.value }))}
                          />
                        </Field>
                        <Field label={t('users.unitAssign.priceNet', 'Preis netto (€)')}>
                          <input
                            className={inputCls}
                            type="number" min="0" step="100"
                            placeholder="190000"
                            value={newUnitForm.price_net}
                            onChange={e => setNewUnitForm(f => ({ ...f, price_net: e.target.value }))}
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* ── Verwaltung (nur bei Rolle Verwalter) ─────── */}
              {form.role === 'verwalter' && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-2">
                    {t('users.management.heading', 'Verwaltungsunternehmen')}
                  </h3>
                  <CustomSelect
                    className={inputCls}
                    value={form.verwaltung_id}
                    onChange={val => setF('verwaltung_id', val)}
                    options={[
                      { value: '', label: t('users.management.none', '– Keiner Verwaltung zugeordnet –') },
                      ...verwaltungOptions.map(v => ({ value: v.id, label: v.name })),
                    ]}
                    placeholder={t('users.management.none', '– Keiner Verwaltung zugeordnet –')}
                  />
                  {verwaltungOptions.length === 0 && (
                    <p className="text-xs text-amber-600 font-body mt-1">
                      {t('users.management.noneCreatedYet', 'Noch keine Verwaltungen angelegt.')}{' '}
                      <a href="/admin/verwaltungen" target="_blank" className="underline">{t('users.management.createNow', 'Jetzt anlegen →')}</a>
                    </p>
                  )}
                </section>
              )}

              {/* ── Adresse ───────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                               font-body mb-1">{t('users.sections.address')}</h3>
                <div className="grid grid-cols-1 gap-3">
                  <Field label={t('users.form.street')}>
                    <input className={inputCls} value={form.address_street}
                           onChange={e => setF('address_street', e.target.value)}
                           placeholder={t('users.form.streetPlaceholder', 'Musterstraße 12')} />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={t('users.form.zip')}>
                      <input className={inputCls} value={form.address_zip}
                             onChange={e => setF('address_zip', e.target.value)}
                             placeholder="12345" />
                    </Field>
                    <div className="col-span-2">
                      <Field label={t('users.form.city')}>
                        <input className={inputCls} value={form.address_city}
                               onChange={e => setF('address_city', e.target.value)}
                               placeholder="Berlin" />
                      </Field>
                    </div>
                  </div>
                  <Field label={t('users.form.country')}>
                    <input className={inputCls} value={form.address_country}
                           onChange={e => setF('address_country', e.target.value)}
                           placeholder={t('users.form.countryPlaceholder', 'Deutschland')} />
                  </Field>
                </div>
              </section>

              {/* ── Bankverbindung ─────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                               font-body mb-3">{t('owner.bank.title')}</h3>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                      {t('owner.bank.iban')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input className={`${inputCls} font-mono flex-1`}
                             value={form.iban}
                             onChange={e => setF('iban', e.target.value)}
                             placeholder="DE89 3704 0044 0532 0130 00" />
                    </div>
                    {form.iban && (
                      <p className="text-xs text-gray-400 font-body mt-0.5 font-mono">
                        {t('owner.bank.masked')}: {maskIban(form.iban)}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('owner.bank.bic')}>
                      <input className={`${inputCls} font-mono`}
                             value={form.bic}
                             onChange={e => setF('bic', e.target.value)}
                             placeholder="COBADEFFXXX" />
                    </Field>
                    <Field label={t('owner.bank.holder')}>
                      <input className={inputCls}
                             value={form.bank_account_holder}
                             onChange={e => setF('bank_account_holder', e.target.value)}
                             placeholder="Max Mustermann" />
                    </Field>
                  </div>
                </div>
              </section>

              {/* ── Einladungs-Info (neu anlegen) ────────── */}
              {modal === 'new' && (
                <div className="flex items-start gap-3 bg-blue-50 border border-blue-100
                                rounded-xl px-4 py-3">
                  <span className="text-lg shrink-0">✉️</span>
                  <div>
                    <p className="text-sm font-semibold text-blue-800 font-body">
                      {t('users.inviteInfo.title', 'Zugangsdaten werden automatisch per E-Mail versendet')}
                    </p>
                    <p className="text-xs text-blue-700 font-body mt-0.5">
                      {t('users.inviteInfo.detail', 'Nach dem Anlegen erhält der Nutzer automatisch eine E-Mail mit Login-Daten.')}
                    </p>
                  </div>
                </div>
              )}

              {/* ── Passwort zurücksetzen (bearbeiten) ───── */}
              {modal === 'edit' && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                                 font-body mb-3">{t('users.sections.password')}</h3>
                  <button
                    type="button"
                    onClick={handleResetPassword}
                    disabled={saving}
                    className="w-full py-2.5 rounded-xl border border-gray-200 text-sm
                               font-medium font-body text-gray-700 hover:border-gray-300
                               hover:bg-gray-50 transition-colors disabled:opacity-50">
                    🔑 {t('users.passwordSection.generateButton', 'Neues Passwort generieren & per E-Mail senden')}
                  </button>
                  <p className="text-xs text-gray-400 font-body mt-1">
                    {t('users.passwordSection.note', 'Setzt ein neues Passwort und sendet es dem Nutzer automatisch per E-Mail.')}
                  </p>
                </section>
              )}

              {/* ── Eigentümer-Immobilien ─────────────────── */}
              {modal === 'edit' && form.role === 'eigentuemer' && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                                 font-body mb-3">{t('users.properties.title')}</h3>

                  {ownerProps.length === 0 ? (
                    <p className="text-xs text-gray-400 font-body mb-3">
                      {t('users.properties.none')}
                    </p>
                  ) : (
                    <div className="space-y-2 mb-3">
                      {ownerProps.map(p => (
                        <div key={p.id}
                             className="rounded-xl border border-gray-100 bg-white overflow-hidden
                                        shadow-sm hover:shadow-md hover:border-orange-200 transition-all">
                          {/* Farbstreifen oben */}
                          <div className="h-1"
                               style={{ backgroundColor: p.property_status === 'under_construction' ? '#3b82f6' : '#22c55e' }} />
                          <div className="px-3 py-2.5">
                            {/* Titelzeile + Entfernen-Button */}
                            <div className="flex items-start justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => navigate(`/admin/properties/${p.id}`)}
                                className="flex-1 text-left group">
                                <p className="text-sm font-semibold text-hp-black font-body
                                             group-hover:text-orange-500 transition-colors leading-tight">
                                  {p.project_name}
                                  {p.unit_number && (
                                    <span className="font-normal text-gray-400 ml-1.5">#{p.unit_number}</span>
                                  )}
                                </p>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveProperty(p.id, editUser!.id)}
                                className="text-[10px] text-red-300 hover:text-red-500 font-body shrink-0 mt-0.5 transition-colors">
                                ✕
                              </button>
                            </div>
                            {/* Badges: Typ, Status, Größe, Preis */}
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {p.type && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-body font-medium">
                                  {p.type === 'apartment' ? t('users.propertyType.apartment', 'Apartment') : p.type === 'villa' ? 'Villa' : 'Studio'}
                                </span>
                              )}
                              {p.bedrooms != null && p.bedrooms > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-body">
                                  🛏 {p.bedrooms}
                                </span>
                              )}
                              {p.size_sqm != null && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-body">
                                  📐 {p.size_sqm} m²
                                </span>
                              )}
                              {p.purchase_price_gross != null && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-body font-medium">
                                  {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(p.purchase_price_gross)}
                                </span>
                              )}
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-body font-medium
                                ${p.property_status === 'under_construction'
                                  ? 'bg-blue-50 text-blue-600'
                                  : 'bg-green-50 text-green-700'}`}>
                                {p.property_status === 'under_construction' ? `🏗 ${t('users.propertyStatus.underConstruction', 'Im Bau')}` : `✅ ${t('users.propertyStatus.active', 'Aktiv')}`}
                              </span>
                            </div>
                            {/* Link-Hinweis */}
                            <button
                              type="button"
                              onClick={() => navigate(`/admin/properties/${p.id}`)}
                              className="mt-1.5 text-[10px] text-orange-400 hover:text-orange-600
                                         font-body transition-colors flex items-center gap-0.5">
                              {t('users.properties.open', 'Öffnen →')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Assign property */}
                  <div className="flex gap-2">
                    <CustomSelect
                      className={`${inputCls} flex-1`}
                      value={assignPropId}
                      onChange={val => setAssignPropId(val)}
                      options={[
                        { value: '', label: t('users.properties.selectToAssign') },
                        ...unassignedProps.map(p => ({
                          value: p.id,
                          label: `${p.project_name}${p.unit_number ? ` · ${p.unit_number}` : ''}`,
                        })),
                      ]}
                      placeholder={t('users.properties.selectToAssign')}
                    />
                    <button
                      type="button"
                      disabled={!assignPropId || saving}
                      onClick={handleAssignProperty}
                      className="shrink-0 px-3 py-2 rounded-xl text-sm font-medium
                                 font-body text-white disabled:opacity-40 transition-opacity"
                      style={{ backgroundColor: 'var(--color-highlight)' }}>
                      {t('users.properties.assign')}
                    </button>
                  </div>
                </section>
              )}

              {/* ── Fehler ────────────────────────────────── */}
              {formError && (
                <p className="text-sm font-body text-red-500 bg-red-50 px-4 py-2.5
                              rounded-xl border border-red-100">
                  {formError}
                </p>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between gap-3 px-6 py-4
                            border-t border-gray-100">
              <button onClick={closeModal}
                      className="px-4 py-2 rounded-xl border border-gray-200 text-sm
                                 font-medium font-body text-gray-600 hover:border-gray-300
                                 transition-colors">
                {t('common.cancel')}
              </button>
              <button
                onClick={modal === 'new' ? handleCreate : handleUpdate}
                disabled={saving}
                className="px-6 py-2 rounded-xl text-white text-sm font-semibold
                           font-body transition-opacity hover:opacity-90 disabled:opacity-50
                           flex items-center gap-2"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {saving && (
                  <span className="w-4 h-4 border-2 rounded-full animate-spin inline-block"
                        style={{ borderColor: 'rgba(255,255,255,0.4)', borderTopColor: '#fff' }} />
                )}
                {modal === 'new' ? t('users.actions.create') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Löschen-Bestätigungs-Dialog ────────────────────── */}
      {deleteTarget && (() => {
        const userOwnedProps = allProps.filter(p => p.owner_id === deleteTarget.id)
        const adminCount     = users.filter(u => u.role === 'admin').length
        const isSelf         = profile?.id === deleteTarget.id
        const isLastAdmin    = deleteTarget.role === 'admin' && adminCount <= 1
        const hasProperties  = userOwnedProps.length > 0
        const blocked        = isSelf || isLastAdmin || hasProperties

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center
                          bg-black/50 backdrop-blur-sm px-4"
               onClick={e => { if (e.target === e.currentTarget && !deleting) setDeleteTarget(null) }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">

              {/* Icon + Titel */}
              <div className="flex items-center gap-3 mb-5">
                <div className="w-11 h-11 rounded-full bg-red-100 flex items-center
                                justify-center text-xl shrink-0">🗑️</div>
                <div>
                  <h2 className="text-base font-bold text-hp-black font-body">
                    {t('users.delete.title')}
                  </h2>
                  <p className="text-sm text-gray-500 font-body mt-0.5">
                    {deleteTarget.full_name || deleteTarget.email}
                  </p>
                </div>
              </div>

              {/* Warnungen */}
              <div className="space-y-3 mb-6">

                {/* Standard-Warnung */}
                {!blocked && (
                  <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                    <p className="text-sm text-red-700 font-body">
                      ⚠️ {t('users.delete.irreversible')}
                    </p>
                  </div>
                )}

                {/* Selbst-Löschung */}
                {isSelf && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                    <p className="text-sm text-amber-700 font-body font-semibold">
                      🚫 {t('users.delete.cannotSelf')}
                    </p>
                  </div>
                )}

                {/* Letzter Admin */}
                {!isSelf && isLastAdmin && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                    <p className="text-sm text-amber-700 font-body font-semibold">
                      🚫 {t('users.delete.lastAdmin')}
                    </p>
                  </div>
                )}

                {/* Hat Immobilien */}
                {hasProperties && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                    <p className="text-sm text-amber-700 font-body font-semibold mb-2">
                      🏠 {t('users.delete.hasProperties', { count: userOwnedProps.length })}
                    </p>
                    <ul className="space-y-1.5">
                      {userOwnedProps.map(p => (
                        <li key={p.id} className="flex items-center justify-between gap-2">
                          <span className="text-xs text-amber-700 font-body flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                            {p.project_name}{p.unit_number ? ` · ${p.unit_number}` : ''}
                          </span>
                          <Link
                            to={`/admin/properties/${p.id}`}
                            onClick={() => setDeleteTarget(null)}
                            className="text-xs font-semibold text-amber-700 underline hover:text-amber-900 whitespace-nowrap">
                            {t('users.delete.changeOwner', 'Eigentümer ändern →')}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-amber-600 font-body mt-2">
                      {t('users.delete.reassignFirst')}
                    </p>
                  </div>
                )}
              </div>

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm
                             font-semibold font-body text-gray-600 hover:border-gray-300
                             transition-colors disabled:opacity-50">
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={blocked || deleting}
                  className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                             font-body bg-red-500 hover:bg-red-600 transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed
                             flex items-center justify-center gap-2">
                  {deleting && (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white
                                     rounded-full animate-spin" />
                  )}
                  {t('users.delete.confirm')}
                </button>
              </div>

            </div>
          </div>
        )
      })()}

    </DashboardLayout>
  )
}
