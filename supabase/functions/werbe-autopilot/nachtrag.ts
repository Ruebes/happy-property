// Aktion zuordnung_nachtragen: Meta-Zuordnung (Anzeige, Anzeigengruppe, Kampagne,
// Formular) für Sofortformular-Leads per Graph nachtragen.
//
// Kandidaten: leads.meta_ad_id leer UND (meta_leadgen_id gesetzt ODER Notiz
// „Meta-Lead-ID: <15-17 Ziffern>“). Graph GET /{leadgen_id}?fields=ad_id,adset_id,
// campaign_id,form_id mit dem Seiten-Token (Lead-Abruf verlangt ihn, wie
// meta-leads-sync; Token nur im Speicher, nie im Log).
//
// Standard ist der Probelauf (schreiben fehlt/false): nur Liste zurück, nichts
// geschrieben. Mit {schreiben:true} werden NUR leere meta_*-Felder gefüllt,
// meta_attr_quelle = 'graph_backfill', meta_attr_at = Laufzeitpunkt, und jede
// Änderung in leads_meta_nachtrag protokolliert (Rückbau:
// rollback/20261003102000_leads_meta_backfill.down.sql oder
// update leads set meta_* = null where meta_attr_quelle = 'graph_backfill').
// Ohne Protokolltabelle wird nicht geschrieben.

import { GRAPH, MetaApiError, graphGet, metaEnv, metaErrorFromBody } from '../_shared/metaGraph.ts'
import { type Sb, dbFehler, digits, errMsg, tabelleFehlt, toStr } from './gemeinsam.ts'

const LEADGEN_RE = /Meta-Lead-ID:\s*([0-9]{15,17})(?![0-9])/
const ID_RE = /^[0-9]{6,25}$/
const ZEITBUDGET_MS = 110_000

interface Kandidat {
  id: string
  created_at: string
  meta_leadgen_id: string | null
  notes: string | null
  meta_ad_id: string | null
  meta_adset_id: string | null
  meta_campaign_id: string | null
  meta_form_id: string | null
  meta_attr_quelle: string | null
  meta_attr_at: string | null
}

interface Treffer {
  lead_id: string
  leadgen_id: string
  leadgen_quelle: 'spalte' | 'notiz'
  ad_id: string | null
  adset_id: string | null
  campaign_id: string | null
  form_id: string | null
  geschrieben?: boolean
  fehler?: string
}

async function seitenToken(): Promise<string | null> {
  const { pageId } = metaEnv()
  const j = await graphGet<{ data?: Array<{ id?: string; access_token?: string }> }>('me/accounts', { fields: 'id,access_token', limit: 100 })
  const eigen = (j.data ?? []).find(p => String(p.id ?? '') === pageId)
  return eigen?.access_token ?? null
}

/** GET /{leadgen} mit Seiten-Token (Header, nie in der URL). */
async function leadAbrufen(leadgenId: string, token: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${GRAPH}/${leadgenId}?fields=ad_id,adset_id,campaign_id,form_id`, {
      headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
    })
    const text = await res.text()
    let j: unknown = null
    try { j = text ? JSON.parse(text) : null } catch { j = null }
    if (!res.ok || (j as { error?: unknown } | null)?.error) throw metaErrorFromBody(res.status, j, `HTTP ${res.status}`)
    return (j ?? {}) as Record<string, unknown>
  } catch (err) {
    if (err instanceof MetaApiError) throw err
    const abgebrochen = err instanceof Error && err.name === 'AbortError'
    throw new MetaApiError({ status: 0, kind: 'transient', message: abgebrochen ? 'Zeitüberschreitung' : errMsg(err).slice(0, 120) })
  } finally {
    clearTimeout(timer)
  }
}

const idOder = (v: unknown): string | null => {
  const s = digits(v)
  return ID_RE.test(s) ? s : null
}

export async function zuordnungNachtragen(sb: Sb, body: Record<string, unknown>, now: Date): Promise<Record<string, unknown>> {
  const schreiben = body.schreiben === true
  const limit = Math.max(1, Math.min(300, Math.floor(Number(body.limit ?? 100)) || 100))
  const seitTage = Math.max(1, Math.min(400, Math.floor(Number(body.seit_tage ?? 120)) || 120))
  const seit = new Date(now.getTime() - seitTage * 86400000).toISOString()

  if (schreiben) {
    const { error } = await sb.from('leads_meta_nachtrag').select('lead_id').limit(1)
    if (error) {
      return {
        success: false, schreiben,
        error: tabelleFehlt(error)
          ? 'Protokolltabelle leads_meta_nachtrag fehlt: erst Migration 20261003102000 einspielen, dann erneut mit schreiben:true.'
          : `leads_meta_nachtrag: ${dbFehler(error)}`,
      }
    }
  }

  const { data, error } = await sb.from('leads')
    .select('id, created_at, meta_leadgen_id, notes, meta_ad_id, meta_adset_id, meta_campaign_id, meta_form_id, meta_attr_quelle, meta_attr_at')
    .is('meta_ad_id', null)
    .gte('created_at', seit)
    .or('meta_leadgen_id.not.is.null,notes.ilike.*Meta-Lead-ID*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return { success: false, schreiben, error: `leads: ${dbFehler(error)}` }

  const kandidaten: Array<Kandidat & { leadgen: string; quelle: 'spalte' | 'notiz' }> = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const k: Kandidat = {
      id: String(r.id), created_at: String(r.created_at ?? ''),
      meta_leadgen_id: toStr(r.meta_leadgen_id), notes: toStr(r.notes),
      meta_ad_id: toStr(r.meta_ad_id), meta_adset_id: toStr(r.meta_adset_id), meta_campaign_id: toStr(r.meta_campaign_id),
      meta_form_id: toStr(r.meta_form_id), meta_attr_quelle: toStr(r.meta_attr_quelle), meta_attr_at: toStr(r.meta_attr_at),
    }
    const ausSpalte = k.meta_leadgen_id && /^[0-9]{15,17}$/.test(k.meta_leadgen_id) ? k.meta_leadgen_id : null
    const ausNotiz = k.notes ? LEADGEN_RE.exec(k.notes)?.[1] ?? null : null
    const leadgen = ausSpalte ?? ausNotiz
    if (!leadgen) continue
    kandidaten.push({ ...k, leadgen, quelle: ausSpalte ? 'spalte' : 'notiz' })
  }

  const liste: Treffer[] = []
  const fehler: string[] = []
  let token: string | null = null
  try {
    token = kandidaten.length ? await seitenToken() : null
  } catch (err) {
    const e = err instanceof MetaApiError ? `${err.kind}: ${err.userMsg ?? err.message}` : errMsg(err)
    return { success: false, schreiben, error: `Seiten-Token nicht abrufbar (${e.slice(0, 200)})`, kandidaten: kandidaten.length }
  }
  if (kandidaten.length && !token) {
    return { success: false, schreiben, error: 'Kein Seiten-Token für die eigene Facebook-Seite (me/accounts).', kandidaten: kandidaten.length }
  }

  let abbruch: string | null = null
  const start = Date.now()
  for (const k of kandidaten) {
    if (abbruch) break
    // Zeitbudget (Function-Laufzeit): Rest im nächsten Aufruf
    if (Date.now() - start > ZEITBUDGET_MS) { abbruch = 'Zeitbudget erreicht, Rest beim nächsten Aufruf'; break }
    let j: Record<string, unknown>
    try {
      j = await leadAbrufen(k.leadgen, token as string)
    } catch (err) {
      const e = err instanceof MetaApiError ? err : null
      const text = e ? `${e.kind}${e.code != null ? ` ${e.code}` : ''}: ${(e.userMsg ?? e.message).slice(0, 120)}` : errMsg(err).slice(0, 120)
      liste.push({ lead_id: k.id, leadgen_id: k.leadgen, leadgen_quelle: k.quelle, ad_id: null, adset_id: null, campaign_id: null, form_id: null, fehler: text })
      if (e && (e.kind === 'rate_limit' || e.kind === 'auth')) abbruch = `Abbruch nach ${e.kind}`
      continue
    }
    const t: Treffer = {
      lead_id: k.id, leadgen_id: k.leadgen, leadgen_quelle: k.quelle,
      ad_id: idOder(j.ad_id), adset_id: idOder(j.adset_id), campaign_id: idOder(j.campaign_id), form_id: idOder(j.form_id),
    }
    liste.push(t)
    if (!schreiben || !(t.ad_id || t.adset_id || t.campaign_id)) continue

    // Nur leere Felder füllen; Gleichzeitigkeit: nur solange meta_ad_id noch leer ist
    const ts = new Date().toISOString()
    const patch: Record<string, unknown> = { meta_attr_quelle: 'graph_backfill', meta_attr_at: ts }
    const geschrieben = { ad: null as string | null, adset: null as string | null, campaign: null as string | null, leadgen: null as string | null }
    if (t.ad_id) { patch.meta_ad_id = t.ad_id; geschrieben.ad = t.ad_id }
    if (t.adset_id && !k.meta_adset_id) { patch.meta_adset_id = t.adset_id; geschrieben.adset = t.adset_id }
    if (t.campaign_id && !k.meta_campaign_id) { patch.meta_campaign_id = t.campaign_id; geschrieben.campaign = t.campaign_id }
    if (!k.meta_leadgen_id) { patch.meta_leadgen_id = k.leadgen; geschrieben.leadgen = k.leadgen }
    if (t.form_id && !k.meta_form_id) patch.meta_form_id = t.form_id
    const { data: upd, error: uErr } = await sb.from('leads').update(patch).eq('id', k.id).is('meta_ad_id', null).select('id')
    if (uErr) { t.fehler = `leads: ${dbFehler(uErr)}`; fehler.push(`${k.id}: ${t.fehler}`); continue }
    if (!Array.isArray(upd) || !upd.length) { t.fehler = 'inzwischen schon zugeordnet'; continue }

    // Protokoll (Rückbau); vorhandene Zeile aus dem SQL-Nachtrag behält vorher_quelle/vorher_at
    const { data: alt, error: aErr } = await sb.from('leads_meta_nachtrag')
      .select('lead_id, meta_leadgen_id').eq('lead_id', k.id).maybeSingle()
    let pErr: unknown = aErr
    if (!aErr) {
      if (alt) {
        const { error } = await sb.from('leads_meta_nachtrag').update({
          meta_ad_id: geschrieben.ad, meta_adset_id: geschrieben.adset, meta_campaign_id: geschrieben.campaign,
          meta_leadgen_id: toStr((alt as { meta_leadgen_id?: unknown }).meta_leadgen_id) ?? geschrieben.leadgen,
          meta_attr_quelle: 'graph_backfill', meta_attr_at: ts,
        }).eq('lead_id', k.id)
        pErr = error
      } else {
        const { error } = await sb.from('leads_meta_nachtrag').insert({
          lead_id: k.id, meta_ad_id: geschrieben.ad, meta_adset_id: geschrieben.adset, meta_campaign_id: geschrieben.campaign,
          meta_leadgen_id: geschrieben.leadgen, meta_attr_quelle: 'graph_backfill', meta_attr_at: ts,
          vorher_quelle: k.meta_attr_quelle, vorher_at: k.meta_attr_at,
        })
        pErr = error
      }
    }
    if (pErr) {
      // Ohne Protokoll keine Änderung: Lead auf den vorherigen Stand zurück
      const zurueck: Record<string, unknown> = { meta_attr_quelle: k.meta_attr_quelle, meta_attr_at: k.meta_attr_at, meta_ad_id: null }
      if (geschrieben.adset) zurueck.meta_adset_id = null
      if (geschrieben.campaign) zurueck.meta_campaign_id = null
      if (geschrieben.leadgen) zurueck.meta_leadgen_id = null
      if (patch.meta_form_id) zurueck.meta_form_id = null
      const { error: rErr } = await sb.from('leads').update(zurueck).eq('id', k.id).eq('meta_attr_quelle', 'graph_backfill')
      t.fehler = `Protokoll: ${dbFehler(pErr)}${rErr ? ` (Zurücksetzen fehlgeschlagen: ${dbFehler(rErr)})` : ' (Lead zurückgesetzt)'}`
      fehler.push(`${k.id}: ${t.fehler}`)
      continue
    }
    t.geschrieben = true
  }

  return {
    success: true,
    schreiben,
    probelauf: !schreiben,
    seit_tage: seitTage,
    kandidaten: kandidaten.length,
    aufgeloest: liste.filter(t => t.ad_id || t.adset_id || t.campaign_id).length,
    geschrieben: liste.filter(t => t.geschrieben).length,
    abbruch,
    fehler,
    liste: liste.slice(0, 300),
  }
}
