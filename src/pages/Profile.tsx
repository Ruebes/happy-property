import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import { useAuth, roleToPath, ROLE_META } from '../lib/auth'

// ── IBAN maskieren ────────────────────────────────────────────
function maskIban(iban: string): string {
  const clean = iban.replace(/\s/g, '')
  if (clean.length < 6) return iban
  const start = clean.slice(0, 4)
  const end   = clean.slice(-2)
  const stars = '*'.repeat(Math.max(0, clean.length - 6))
  const raw   = `${start}${stars}${end}`
  return raw.match(/.{1,4}/g)?.join(' ') ?? raw
}

interface ProfileData {
  full_name:           string
  email:               string
  phone:               string | null
  language:            string
  address_street:      string | null
  address_zip:         string | null
  address_city:        string | null
  address_country:     string | null
  iban:                string | null
  bic:                 string | null
  bank_account_holder: string | null
}

const inputCls = `w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-hp-black
  text-sm font-body focus:outline-none focus:ring-2 focus:border-transparent transition`

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 font-body mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 font-body mt-0.5">{hint}</p>}
    </div>
  )
}

function Toast({ msg, type = 'success', onClose }: {
  msg: string; type?: 'success' | 'error'; onClose: () => void
}) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t) }, [onClose])
  return (
    <div className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-xl text-sm
                    font-body flex items-center gap-3
                    ${type === 'error' ? 'bg-red-600 text-white' : 'bg-hp-black text-white'}`}>
      {type === 'success' ? '✓' : '✕'} {msg}
      <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100">✕</button>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
export default function Profile() {
  const { t }       = useTranslation()
  const { profile, updatePassword } = useAuth()

  const isEigentuemer = profile?.role === 'eigentuemer'
  const basePath      = profile ? roleToPath(profile.role) : '/login'
  const roleColor     = profile ? ROLE_META[profile.role].color : ''

  // ── Profil-State ─────────────────────────────────────────
  const [data, setData]       = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [toast, setToast]     = useState<{ msg: string; type?: 'success' | 'error' } | null>(null)

  // Editierbare Felder – Kontakt
  const [phone, setPhone]         = useState('')
  const [language, setLanguage]   = useState('de')

  // Editierbare Felder – Adresse
  const [street, setStreet]   = useState('')
  const [zip, setZip]         = useState('')
  const [city, setCity]       = useState('')
  const [country, setCountry] = useState('Deutschland')

  // Editierbare Felder – Bank (nur Eigentümer)
  const [iban, setIban]             = useState('')
  const [bic, setBic]               = useState('')
  const [bankHolder, setBankHolder] = useState('')
  const [showIban, setShowIban]     = useState(false)

  // ── Passwort-Sektion ──────────────────────────────────────
  const [newPw, setNewPw]       = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwSaving, setPwSaving]   = useState(false)
  const [pwError, setPwError]     = useState('')
  const [showNewPw, setShowNewPw]     = useState(false)
  const [showConfirmPw, setShowConfirmPw] = useState(false)

  // ── Profil laden ──────────────────────────────────────────
  const fetchProfile = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    try {
      const { data: row } = await supabase
        .from('profiles')
        .select('full_name, email, phone, language, address_street, address_zip, address_city, address_country, iban, bic, bank_account_holder')
        .eq('id', profile.id)
        .single()
      if (row) {
        const d = row as ProfileData
        setData(d)
        setPhone(d.phone ?? '')
        setLanguage(d.language ?? 'de')
        setStreet(d.address_street ?? '')
        setZip(d.address_zip ?? '')
        setCity(d.address_city ?? '')
        setCountry(d.address_country ?? 'Deutschland')
        setIban(d.iban ?? '')
        setBic(d.bic ?? '')
        setBankHolder(d.bank_account_holder ?? '')
      }
    } catch (err) {
      console.error('[Profile] fetchProfile:', err)
    } finally {
      setLoading(false)
    }
  }, [profile])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  // ── Profil speichern ──────────────────────────────────────
  async function handleSaveProfile() {
    if (!profile || !data) return
    setSaving(true)
    try {
      const updates: Record<string, unknown> = {
        phone:           phone.trim() || null,
        language,
        address_street:  street.trim() || null,
        address_zip:     zip.trim() || null,
        address_city:    city.trim() || null,
        address_country: country.trim() || null,
      }

      if (isEigentuemer) {
        const oldIban    = data.iban ?? ''
        const ibanChanged = iban.trim() !== oldIban.trim()
        updates.iban                = iban.trim() || null
        updates.bic                 = bic.trim() || null
        updates.bank_account_holder = bankHolder.trim() || null

        if (ibanChanged && (oldIban || iban.trim())) {
          await supabase.from('bank_change_notifications').insert({
            owner_id:        profile.id,
            old_iban_masked: oldIban ? maskIban(oldIban) : null,
            new_iban_masked: iban.trim() ? maskIban(iban.trim()) : null,
            status:          'pending',
          })
          supabase.functions.invoke('notify-bank-change', {
            body: {
              owner_name:      data.full_name,
              old_iban_masked: oldIban ? maskIban(oldIban) : t('owner.bank.noIban'),
              new_iban_masked: iban.trim() ? maskIban(iban.trim()) : t('owner.bank.noIban'),
              changed_at:      new Date().toISOString(),
            },
          }).catch(() => {})
        }
      }

      const { error } = await supabase.from('profiles').update(updates).eq('id', profile.id)
      if (error) throw new Error(error.message)

      setToast({ msg: t('profile.saved') })
      fetchProfile()
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : t('errors.saveFailed'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // ── Passwort ändern ───────────────────────────────────────
  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError('')

    if (newPw.length < 8) {
      setPwError(t('profile.passwordTooShort'))
      return
    }
    if (newPw !== confirmPw) {
      setPwError(t('profile.passwordMismatch'))
      return
    }

    setPwSaving(true)
    const { error: err } = await updatePassword(newPw)
    if (err) {
      setPwError(t('errors.saveFailed'))
    } else {
      setNewPw('')
      setConfirmPw('')
      setToast({ msg: t('profile.passwordChanged') })
    }
    setPwSaving(false)
  }

  // ── Loading ───────────────────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout basePath={basePath}>
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      </DashboardLayout>
    )
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <DashboardLayout basePath={basePath}>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      <div className="max-w-xl">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-hp-black"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('profile.title')}
          </h1>
          <p className="text-sm text-gray-400 font-body mt-0.5">
            {t('profile.subtitle')}
          </p>
        </div>

        {/* ── Avatar + Readonly ─────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center
                            text-white text-xl font-bold font-body shrink-0"
                 style={{ backgroundColor: 'var(--color-highlight)' }}>
              {data?.full_name?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
            <div>
              <div className="font-bold text-hp-black font-body text-lg">{data?.full_name}</div>
              <div className="text-sm text-gray-400 font-body">{data?.email}</div>
              {profile && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full font-body mt-1 inline-block ${roleColor}`}>
                  {t(`roles.${profile.role}`)}
                </span>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-400 font-body bg-gray-50 rounded-xl px-3 py-2">
            ℹ️ {t('profile.readonlyHint')}
          </p>
        </div>

        {/* ── Kontakt & Sprache ─────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-5">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
            {t('users.sections.master')}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('users.form.phone')}>
              <input className={inputCls} value={phone}
                     onChange={e => setPhone(e.target.value)}
                     placeholder="+49 170 …" />
            </Field>
            <Field label={t('users.form.language')}>
              <select className={inputCls} value={language}
                      onChange={e => setLanguage(e.target.value)}>
                <option value="de">🇩🇪 Deutsch</option>
                <option value="en">🇬🇧 English</option>
              </select>
            </Field>
          </div>
        </div>

        {/* ── Adresse ───────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-5">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
            {t('users.sections.address')}
          </h2>
          <div className="space-y-3">
            <Field label={t('users.form.street')}>
              <input className={inputCls} value={street}
                     onChange={e => setStreet(e.target.value)}
                     placeholder="Musterstraße 12" />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('users.form.zip')}>
                <input className={inputCls} value={zip}
                       onChange={e => setZip(e.target.value)}
                       placeholder="12345" />
              </Field>
              <div className="col-span-2">
                <Field label={t('users.form.city')}>
                  <input className={inputCls} value={city}
                         onChange={e => setCity(e.target.value)}
                         placeholder="Berlin" />
                </Field>
              </div>
            </div>
            <Field label={t('users.form.country')}>
              <input className={inputCls} value={country}
                     onChange={e => setCountry(e.target.value)}
                     placeholder="Deutschland" />
            </Field>
          </div>
        </div>

        {/* ── Bank (nur Eigentümer) ──────────────────────────── */}
        {isEigentuemer && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-5">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-1">
              {t('owner.bank.title')}
            </h2>
            <p className="text-xs text-amber-600 font-body bg-amber-50 rounded-xl px-3 py-2 mb-4">
              ⚠️ {t('owner.bank.changeWarning')}
            </p>
            <div className="space-y-3">
              <Field label={t('owner.bank.iban')}>
                <div className="relative">
                  <input
                    className={`${inputCls} font-mono pr-10`}
                    value={showIban ? iban : (iban ? maskIban(iban) : '')}
                    onFocus={() => setShowIban(true)}
                    onBlur={() => setShowIban(false)}
                    onChange={e => setIban(e.target.value)}
                    placeholder="DE89 3704 0044 0532 0130 00"
                  />
                  <button type="button"
                          onClick={() => setShowIban(s => !s)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showIban ? '🙈' : '👁'}
                  </button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('owner.bank.bic')}>
                  <input className={`${inputCls} font-mono`} value={bic}
                         onChange={e => setBic(e.target.value)}
                         placeholder="COBADEFFXXX" />
                </Field>
                <Field label={t('owner.bank.holder')}>
                  <input className={inputCls} value={bankHolder}
                         onChange={e => setBankHolder(e.target.value)}
                         placeholder="Max Mustermann" />
                </Field>
              </div>
            </div>
          </div>
        )}

        {/* ── Profil-Speichern-Button ────────────────────────── */}
        <button
          onClick={handleSaveProfile}
          disabled={saving}
          className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                     hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 mb-8"
          style={{ backgroundColor: 'var(--color-highlight)' }}>
          {saving && (
            <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          )}
          {t('profile.save')}
        </button>

        {/* ── Passwort ändern ────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-5">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-1">
            {t('profile.changePassword')}
          </h2>
          <p className="text-xs text-gray-400 font-body mb-4">
            {t('profile.changePasswordHint')}
          </p>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <Field label={t('profile.newPassword')}>
              <div className="relative">
                <input
                  type={showNewPw ? 'text' : 'password'}
                  value={newPw}
                  onChange={e => setNewPw(e.target.value)}
                  placeholder="••••••••"
                  className={`${inputCls} pr-10`}
                />
                <button type="button"
                        onClick={() => setShowNewPw(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">
                  {showNewPw ? '🙈' : '👁'}
                </button>
              </div>
              <p className="text-xs text-gray-400 font-body mt-0.5">{t('setPassword.minLength')}</p>
            </Field>
            <Field label={t('profile.confirmPassword')}>
              <div className="relative">
                <input
                  type={showConfirmPw ? 'text' : 'password'}
                  value={confirmPw}
                  onChange={e => setConfirmPw(e.target.value)}
                  placeholder="••••••••"
                  className={`${inputCls} pr-10`}
                />
                <button type="button"
                        onClick={() => setShowConfirmPw(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">
                  {showConfirmPw ? '🙈' : '👁'}
                </button>
              </div>
            </Field>

            {pwError && (
              <p className="text-sm text-red-500 bg-red-50 px-4 py-2.5 rounded-xl
                            border border-red-100 font-body">{pwError}</p>
            )}

            <button
              type="submit"
              disabled={pwSaving || !newPw || !confirmPw}
              className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                         hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ backgroundColor: 'var(--color-highlight)' }}>
              {pwSaving && (
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {t('profile.changePasswordBtn')}
            </button>
          </form>
        </div>

      </div>
    </DashboardLayout>
  )
}
