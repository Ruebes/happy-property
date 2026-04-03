import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

const inputCls = `w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-hp-black
  text-sm font-body focus:outline-none focus:ring-2 focus:border-transparent transition`

export default function FeriengastProfil() {
  const { t }       = useTranslation()
  const { profile } = useAuth()

  const [phone, setPhone]         = useState('')
  const [language, setLanguage]   = useState('de')
  const [nationality, setNationality] = useState('')
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState('')
  const [toastType, setToastType] = useState<'success' | 'error'>('success')
  const [loading, setLoading]     = useState(true)

  const load = useCallback(async () => {
    if (!profile) return
    const { data } = await supabase
      .from('profiles')
      .select('phone, language, nationality')
      .eq('id', profile.id)
      .single()
    if (data) {
      setPhone(data.phone ?? '')
      setLanguage(data.language ?? 'de')
      setNationality((data as { nationality?: string }).nationality ?? '')
    }
    setLoading(false)
  }, [profile])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    if (!profile) return
    setSaving(true)
    const { error } = await supabase
      .from('profiles')
      .update({ phone: phone.trim() || null, language, nationality: nationality.trim() || null })
      .eq('id', profile.id)
    setSaving(false)
    if (error) {
      setToastType('error')
      setToast(t('errors.saveFailed'))
    } else {
      setToastType('success')
      setToast(t('profile.saved'))
    }
    setTimeout(() => setToast(''), 3000)
  }

  return (
    <GuestLayout>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-5 py-3 text-white text-sm
                        font-body rounded-2xl shadow-xl flex items-center gap-2
                        ${toastType === 'error' ? 'bg-red-600' : 'bg-hp-black'}`}>
          {toastType === 'error' ? '✗' : '✓'} {toast}
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-hp-black font-body">{t('profile.title')}</h1>
        <p className="text-sm text-gray-400 font-body mt-0.5">{t('profile.subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="max-w-lg space-y-5">
          {/* Readonly info */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl
                              font-bold font-body shrink-0"
                   style={{ backgroundColor: 'var(--color-highlight)' }}>
                {profile?.full_name?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
              <div>
                <div className="font-bold text-hp-black font-body text-lg">{profile?.full_name}</div>
                <div className="text-sm text-gray-400 font-body">{profile?.email}</div>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-body mt-1 inline-block">
                  {t('roles.feriengast')}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-400 font-body bg-gray-50 rounded-xl px-3 py-2">
              ℹ️ {t('profile.readonlyHint')}
            </p>
          </div>

          {/* Editable */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body">
              {t('users.sections.master')}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                  {t('users.form.phone')}
                </label>
                <input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)}
                       placeholder="+49 170 …" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                  {t('users.form.language')}
                </label>
                <select className={inputCls} value={language} onChange={e => setLanguage(e.target.value)}>
                  <option value="de">🇩🇪 Deutsch</option>
                  <option value="en">🇬🇧 English</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('guest.profile.nationality')}
              </label>
              <input className={inputCls} value={nationality} onChange={e => setNationality(e.target.value)}
                     placeholder="Deutsch / German" />
            </div>
          </div>

          <button onClick={handleSave} disabled={saving}
                  className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                             hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
            {saving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {t('profile.save')}
          </button>
        </div>
      )}
    </GuestLayout>
  )
}
