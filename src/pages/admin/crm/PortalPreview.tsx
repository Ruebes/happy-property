import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { CustomSelect } from '../../../components/CustomSelect'
import { supabase } from '../../../lib/supabase'
import { useAuth, roleToPath } from '../../../lib/auth'
import type { Profile } from '../../../lib/permissions'
import type { PreviewRole } from '../../../lib/preview'

// ── Portal-Vorschau ───────────────────────────────────────────────────────────
// Sven sieht jedes Kundenportal so, wie es eine bestimmte Person sieht:
// Eigentümer (echte Eigentümer mit ihren Wohnungen), Verwaltung (je
// Verwaltungsfirma) und Feriengast (Muster-Gast). Technik in lib/preview.ts:
// nur lesen, schreibende Anfragen werden im Browser blockiert.

interface OwnerOpt { id: string; full_name: string | null; email: string | null; phone: string | null; language: string | null; units: number }
interface VerwOpt { id: string; name: string; ansprechpartner: string | null }

const GUEST_ID = '00000000-0000-4000-8000-00000000f001'

export default function PortalPreview() {
  const { realProfile, startPreview } = useAuth()
  const navigate = useNavigate()
  const [owners, setOwners] = useState<OwnerOpt[]>([])
  const [verws, setVerws] = useState<VerwOpt[]>([])
  const [owner, setOwner] = useState('')
  const [verw, setVerw] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [{ data: pr, error: e1 }, { data: props, error: e2 }, { data: vw, error: e3 }] = await Promise.all([
          supabase.from('profiles').select('id, full_name, email, phone, language').eq('role', 'eigentuemer').order('full_name'),
          supabase.from('properties').select('owner_id').not('owner_id', 'is', null),
          supabase.from('verwaltungen').select('id, name, ansprechpartner').order('name'),
        ])
        if (e1 || e2 || e3) throw e1 ?? e2 ?? e3
        const count: Record<string, number> = {}
        for (const p of (props ?? []) as Array<{ owner_id: string }>) count[p.owner_id] = (count[p.owner_id] ?? 0) + 1
        const list = ((pr ?? []) as Omit<OwnerOpt, 'units'>[]).map(o => ({ ...o, units: count[o.id] ?? 0 }))
          .sort((a, b) => (b.units > 0 ? 1 : 0) - (a.units > 0 ? 1 : 0) || (a.full_name ?? '').localeCompare(b.full_name ?? ''))
        setOwners(list)
        setOwner(list.find(o => o.units > 0)?.id ?? list[0]?.id ?? '')
        const v = (vw ?? []) as VerwOpt[]
        setVerws(v)
        setVerw(v[0]?.id ?? '')
      } catch (e) {
        console.error('[PortalPreview] load:', e)
        setErr('Konnte nicht geladen werden. Bitte Seite neu laden.')
      }
    })()
  }, [])

  const go = (role: PreviewRole, profile: Profile, label: string) => {
    startPreview({ role, profile, label })
    navigate(roleToPath(role))
  }

  const openOwner = () => {
    const o = owners.find(x => x.id === owner)
    if (!o) return
    go('eigentuemer', { id: o.id, email: o.email ?? '', full_name: o.full_name ?? '', phone: o.phone, role: 'eigentuemer', language: o.language ?? 'de', verwaltung_id: null, permissions: {} } as unknown as Profile, o.full_name ?? o.email ?? 'Eigentümer')
  }
  const openVerw = () => {
    const v = verws.find(x => x.id === verw)
    if (!v || !realProfile) return
    go('verwalter', { ...realProfile, full_name: v.ansprechpartner ?? v.name, role: 'verwalter', verwaltung_id: v.id, permissions: {} } as Profile, v.name)
  }
  const openGuest = () => {
    go('feriengast', { id: GUEST_ID, email: 'gast@beispiel.de', full_name: 'Max Mustermann', phone: null, role: 'feriengast', language: 'de', verwaltung_id: null, permissions: {} } as unknown as Profile, 'Muster-Feriengast')
  }

  const card = 'bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3'
  const btn = 'px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40'
  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">👁 Portal-Vorschau</h1>
          <p className="text-sm text-gray-500 mt-1">
            Sieh dir jedes Portal so an, wie es deine Kunden sehen. In der Vorschau kannst du alles anklicken, aber nichts speichern, hochladen oder verschicken.
          </p>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className={card}>
          <div>
            <p className="font-semibold text-gray-900">🏠 Eigentümerportal</p>
            <p className="text-xs text-gray-500 mt-0.5">Mit den echten Wohnungen, Dokumenten und Downloads des gewählten Eigentümers.</p>
          </div>
          <CustomSelect value={owner} onChange={setOwner}
            options={owners.map(o => ({ value: o.id, label: `${o.full_name || o.email || '?'} · ${o.units} ${o.units === 1 ? 'Wohnung' : 'Wohnungen'}${o.language === 'en' ? ' · EN' : ''}` }))} />
          <button onClick={openOwner} disabled={!owner} className={btn} style={{ backgroundColor: '#ff795d' }}>Als Eigentümer ansehen</button>
        </div>

        <div className={card}>
          <div>
            <p className="font-semibold text-gray-900">🔑 Verwaltungsportal (Property Service)</p>
            <p className="text-xs text-gray-500 mt-0.5">So sieht es die Verwaltungsfirma, die die Wohnungen betreut.</p>
          </div>
          {verws.length ? (
            <CustomSelect value={verw} onChange={setVerw} options={verws.map(v => ({ value: v.id, label: v.name }))} />
          ) : <p className="text-xs text-gray-400">Noch keine Verwaltungsfirma angelegt.</p>}
          <button onClick={openVerw} disabled={!verw} className={btn} style={{ backgroundColor: '#ff795d' }}>Als Verwaltung ansehen</button>
        </div>

        <div className={card}>
          <div>
            <p className="font-semibold text-gray-900">🧳 Feriengast-Portal</p>
            <p className="text-xs text-gray-500 mt-0.5">Muster-Gast ohne echte Buchung: zeigt Aufbau und Leerzustände (Check-in, Hausregeln, Nachrichten).</p>
          </div>
          <button onClick={openGuest} className={btn} style={{ backgroundColor: '#ff795d' }}>Als Feriengast ansehen</button>
        </div>
      </div>
    </DashboardLayout>
  )
}
