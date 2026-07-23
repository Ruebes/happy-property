import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { PERMISSION_AREAS, type PermissionArea } from '../../lib/auth'

// ── Systemzugang für einen Geschäftskontakt erteilen ────────────────────────────
// Legt den Kontakt als Mitarbeiter an (admin-user-ops create, role='mitarbeiter'),
// setzt die gewählten Rechte und verschickt eine Zugangs-Mail (Login + Passwort).
// Danach taucht die Person in „Mitarbeiter & Rechte" auf.
interface GrantContact {
  first_name: string
  last_name: string | null
  email: string | null
  language?: 'de' | 'en' | null
}

export default function GrantAccessModal({ contact, onClose, onGranted }: {
  contact: GrantContact
  onClose: () => void
  onGranted: (msg: string) => void
}) {
  const { t } = useTranslation()
  const [perms, setPerms] = useState<Partial<Record<PermissionArea, boolean>>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const name = `${contact.first_name} ${contact.last_name ?? ''}`.trim()
  const toggle = (k: PermissionArea) => setPerms(p => ({ ...p, [k]: !p[k] }))

  const grant = async () => {
    if (!contact.email) { setErr(t('crm.grant.errNoEmail', 'Dieser Kontakt hat keine E-Mail — für einen Zugang nötig.')); return }
    setBusy(true); setErr('')
    try {
      const chosen = Object.fromEntries(Object.entries(perms).filter(([, v]) => v)) as Partial<Record<PermissionArea, boolean>>
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: {
          action: 'create',
          email: contact.email.trim().toLowerCase(),
          full_name: name || contact.email,
          role: 'mitarbeiter',
          language: contact.language === 'en' ? 'en' : 'de',
          permissions: chosen,
          send_access_email: true,
        },
      })
      const res = data as { error?: string; userId?: string; emailed?: boolean } | null
      if (error || res?.error) throw new Error(res?.error || error?.message)
      onGranted(res?.emailed
        ? t('crm.grant.doneMailed', '✓ Zugang erteilt — Zugangs-Mail an {{name}} versendet', { name: name || contact.email })
        : t('crm.grant.doneNoMail', '✓ Zugang erteilt für {{name}} (Zugangs-Mail konnte nicht versendet werden — Passwort ggf. manuell zurücksetzen)', { name: name || contact.email }))
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('common.error', 'Fehler'))
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-gray-900">
            {t('crm.grant.title', 'Systemzugang für {{name}}', { name: name || t('crm.grant.thisContact', 'diesen Kontakt') })}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-gray-500 mb-2">
          {t('crm.grant.hint', 'Der Kontakt wird als Mitarbeiter angelegt und bekommt eine Zugangs-Mail. Wähle die Bereiche, die er sehen darf.')}
        </p>
        {contact.email
          ? <p className="text-xs text-gray-400 mb-3">📧 {contact.email}</p>
          : <p className="text-xs text-red-500 mb-3">{t('crm.grant.errNoEmail', 'Dieser Kontakt hat keine E-Mail — für einen Zugang nötig.')}</p>}

        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {PERMISSION_AREAS.map(a => (
            <label key={a.key} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer py-0.5">
              <input type="checkbox" checked={!!perms[a.key]} onChange={() => toggle(a.key)} className="accent-[#ff795d] w-4 h-4" />
              {t(`crm.perm.${a.key}`, a.label)}
            </label>
          ))}
        </div>

        {err && <p className="text-xs text-red-500 mt-2">{err}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button onClick={grant} disabled={busy || !contact.email}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {busy ? t('crm.grant.granting', 'Erteile…') : t('crm.grant.grant', 'Zugang erteilen')}
          </button>
        </div>
      </div>
    </div>
  )
}
