import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { supabaseAdmin } from '../../lib/supabaseAdmin'
import { useAuth } from '../../lib/auth'

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
  id: string
  project_name: string
  unit_number: string | null
  owner_id: string
}

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
  const { t }       = useTranslation()
  const { profile } = useAuth()

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

  // ── Delete state ─────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<UserProfile | null>(null)
  const [deleting, setDeleting]         = useState(false)

  // ── Fetch ────────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      // Profile + echte Auth-User parallel laden
      const [{ data: profileData }, { data: authData, error: authErr }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, email, full_name, phone, role, language, address_street, address_zip, address_city, address_country, iban, bic, bank_account_holder, is_active, created_at')
          .order('created_at', { ascending: false })
          .limit(500),
        supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
      ])

      const profiles = (profileData as UserProfile[]) ?? []

      // Verwaiste Profile bereinigen: Einträge ohne echten Auth-User
      if (!authErr && authData?.users) {
        const authIds = new Set(authData.users.map(u => u.id))
        const orphaned = profiles.filter(p => !authIds.has(p.id))
        if (orphaned.length > 0) {
          // Stille Bereinigung – kein Toast, da Nutzer dies nicht erwartet
          await Promise.all(
            orphaned.map(p => supabaseAdmin.from('profiles').delete().eq('id', p.id))
          )
        }
        setUsers(profiles.filter(p => authIds.has(p.id)))
      } else {
        setUsers(profiles)
      }
    } catch (e) {
      console.error('[fetchUsers]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchProps = useCallback(async () => {
    const { data } = await supabase
      .from('properties')
      .select('id, project_name, unit_number, owner_id')
      .order('project_name')
    setAllProps((data as Property[]) ?? [])
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchProps()
  }, [fetchUsers, fetchProps])

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
    if (form.role === 'eigentuemer') {
      if (!form.address_street.trim()) return t('users.errors.streetRequired')
      if (!form.address_zip.trim())    return t('users.errors.zipRequired')
      if (!form.address_city.trim())   return t('users.errors.cityRequired')
    }
    return ''
  }

  // ── Create user ──────────────────────────────────────────
  // Uses inviteUserByEmail() so Supabase automatically sends the
  // branded invite email with a password-set link (ConfirmationURL).
  async function handleCreate() {
    const err = validate()
    if (err) { setFormError(err); return }
    setSaving(true)
    setFormError('')
    try {
      const full_name = `${form.firstName.trim()} ${form.lastName.trim()}`
      const redirectTo = `${window.location.origin}/login`

      // 1. Invite → sends branded "Konto aktivieren" email automatically
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        form.email.trim(),
        {
          data: { full_name, needs_password_setup: true },
          redirectTo,
        }
      )
      if (authErr) throw new Error(authErr.message)
      const userId = authData.user.id

      // 2. Profile — created immediately so the rest of the app
      //    can reference this owner before they accept the invite.
      const { error: profileErr } = await supabaseAdmin.from('profiles').upsert({
        id:                  userId,
        email:               form.email.trim(),
        full_name,
        phone:               form.phone.trim() || null,
        role:                form.role,
        language:            form.language,
        address_street:      form.address_street.trim() || null,
        address_zip:         form.address_zip.trim() || null,
        address_city:        form.address_city.trim() || null,
        address_country:     form.address_country.trim() || null,
        iban:                form.iban.trim() || null,
        bic:                 form.bic.trim() || null,
        bank_account_holder: form.bank_account_holder.trim() || null,
        is_active:           true,
      })
      if (profileErr) throw new Error(profileErr.message)

      closeModal()
      setToast(t('users.success.created'))
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
      const { error } = await supabaseAdmin.auth.admin.updateUserById(editUser.id, {
        password: form.tempPassword,
        user_metadata: { needs_password_setup: true },
      })
      if (error) throw new Error(error.message)
      setToast(t('users.success.passwordReset'))
      setF('showPassword', true)
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
      // 1. Auth-User löschen (cascadet profiles via ON DELETE CASCADE)
      const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(deleteTarget.id)
      if (authErr) throw new Error(authErr.message)

      // 2. Profil explizit löschen (Fallback falls kein CASCADE aktiv)
      //    Nutze supabaseAdmin um RLS-Einschränkungen zu umgehen
      const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .delete()
        .eq('id', deleteTarget.id)
      // Profil-Fehler ignorieren wenn bereits per CASCADE gelöscht
      if (profileErr && profileErr.code !== 'PGRST116') {
        console.warn('[handleDelete] profile delete:', profileErr.message)
      }

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

  // ── Copy to clipboard ─────────────────────────────────────
  const [copied, setCopied] = useState(false)
  const copyRef = useRef(false)
  function copyPassword() {
    navigator.clipboard.writeText(form.tempPassword)
    setCopied(true)
    copyRef.current = true
    setTimeout(() => { setCopied(false); copyRef.current = false }, 2000)
  }

  // ── Role filter tabs ─────────────────────────────────────
  const roleTabs = [
    { key: 'all',         label: t('users.filter.all') },
    { key: 'admin',       label: t('roles.admin') },
    { key: 'verwalter',   label: t('roles.verwalter') },
    { key: 'eigentuemer', label: t('roles.eigentuemer') },
    { key: 'feriengast',  label: t('roles.feriengast') },
  ]

  // ════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════
  return (
    <DashboardLayout basePath="/admin/dashboard">
      {toast && <Toast msg={toast} onClose={toastCb} />}

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
                      className={`border-b border-gray-50 hover:bg-gray-50/70 transition-colors
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
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 justify-end">
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
                    <select className={inputCls} value={form.role}
                            onChange={e => setF('role', e.target.value as Role)}>
                      <option value="admin">{t('roles.admin')}</option>
                      <option value="verwalter">{t('roles.verwalter')}</option>
                      <option value="eigentuemer">{t('roles.eigentuemer')}</option>
                      <option value="feriengast">{t('roles.feriengast')}</option>
                    </select>
                  </Field>
                  <Field label={t('users.form.phone')}>
                    <input className={inputCls} value={form.phone}
                           onChange={e => setF('phone', e.target.value)}
                           placeholder="+49 170 …" />
                  </Field>
                  <Field label={t('users.form.language')}>
                    <select className={inputCls} value={form.language}
                            onChange={e => setF('language', e.target.value as Lang)}>
                      <option value="de">🇩🇪 Deutsch</option>
                      <option value="en">🇬🇧 English</option>
                    </select>
                  </Field>
                </div>
              </section>

              {/* ── Adresse ───────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                               font-body mb-1">{t('users.sections.address')}</h3>
                {form.role === 'eigentuemer' && (
                  <p className="text-xs text-orange-500 font-body mb-2">
                    {t('users.form.addressRequired')}
                  </p>
                )}
                <div className="grid grid-cols-1 gap-3">
                  <Field label={t('users.form.street')}
                         required={form.role === 'eigentuemer'}>
                    <input className={inputCls} value={form.address_street}
                           onChange={e => setF('address_street', e.target.value)}
                           placeholder="Musterstraße 12" />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={t('users.form.zip')}
                           required={form.role === 'eigentuemer'}>
                      <input className={inputCls} value={form.address_zip}
                             onChange={e => setF('address_zip', e.target.value)}
                             placeholder="12345" />
                    </Field>
                    <div className="col-span-2">
                      <Field label={t('users.form.city')}
                             required={form.role === 'eigentuemer'}>
                        <input className={inputCls} value={form.address_city}
                               onChange={e => setF('address_city', e.target.value)}
                               placeholder="Berlin" />
                      </Field>
                    </div>
                  </div>
                  <Field label={t('users.form.country')}>
                    <input className={inputCls} value={form.address_country}
                           onChange={e => setF('address_country', e.target.value)}
                           placeholder="Deutschland" />
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
                <div className="flex items-start gap-3 bg-green-50 border border-green-100
                                rounded-xl px-4 py-3">
                  <span className="text-lg shrink-0">✉️</span>
                  <div>
                    <p className="text-sm font-semibold text-green-800 font-body">
                      {t('users.invite.emailSent')}
                    </p>
                    <p className="text-xs text-green-700 font-body mt-0.5">
                      {t('users.invite.emailHint')}
                    </p>
                  </div>
                </div>
              )}

              {/* ── Passwort zurücksetzen (bearbeiten) ───── */}
              {modal === 'edit' && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest
                                 font-body mb-3">{t('users.sections.password')}</h3>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        readOnly
                        type={form.showPassword ? 'text' : 'password'}
                        value={form.tempPassword}
                        className={`${inputCls} pr-10 font-mono bg-gray-50`}
                      />
                      <button
                        type="button"
                        onClick={() => setF('showPassword', !form.showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2
                                   text-gray-400 hover:text-gray-600 text-base">
                        {form.showPassword ? '🙈' : '👁'}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={copyPassword}
                      className="shrink-0 px-3 py-2 rounded-xl border border-gray-200
                                 text-xs font-medium text-gray-600 hover:border-gray-300
                                 transition-colors">
                      {copied ? '✓' : t('users.form.copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setF('tempPassword', generatePassword())}
                      className="shrink-0 px-3 py-2 rounded-xl border border-gray-200
                                 text-xs font-medium text-gray-600 hover:border-gray-300
                                 transition-colors">
                      ↻
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleResetPassword}
                    disabled={saving}
                    className="mt-2 w-full py-2 rounded-xl border border-gray-200 text-sm
                               font-medium font-body text-gray-700 hover:border-gray-300
                               hover:bg-gray-50 transition-colors disabled:opacity-50">
                    {t('users.actions.resetPassword')}
                  </button>
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
                    <ul className="space-y-1.5 mb-3">
                      {ownerProps.map(p => (
                        <li key={p.id}
                            className="flex items-center justify-between px-3 py-2
                                       bg-gray-50 rounded-xl border border-gray-100">
                          <span className="text-sm font-body text-hp-black">
                            {p.project_name}
                            {p.unit_number && (
                              <span className="text-gray-400 ml-1">· {p.unit_number}</span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveProperty(p.id, editUser!.id)}
                            className="text-xs text-red-400 hover:text-red-600 font-body">
                            {t('users.properties.remove')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Assign property */}
                  <div className="flex gap-2">
                    <select
                      className={`${inputCls} flex-1`}
                      value={assignPropId}
                      onChange={e => setAssignPropId(e.target.value)}>
                      <option value="">{t('users.properties.selectToAssign')}</option>
                      {unassignedProps.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.project_name}{p.unit_number ? ` · ${p.unit_number}` : ''}
                        </option>
                      ))}
                    </select>
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
                            Eigentümer ändern →
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
