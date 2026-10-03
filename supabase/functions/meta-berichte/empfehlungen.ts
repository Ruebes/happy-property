// meta-berichte, Modus empfehlungen: Potenzialbewertung und Metas Empfehlungen
// (nur lesen; das CRM wendet nichts an, der Link führt in den Werbeanzeigenmanager).
//
//   GET act_<konto>?fields=opportunity_score
//   GET act_<konto>/recommendations   (Form der Antwort je Version unterschiedlich:
//       data[] mit recommendations[] oder direkt Empfehlungen; Texte in
//       recommendation_content oder auf oberster Ebene). Texte auf Deutsch (locale).
// Tolerant: Fehler, fehlende Rechte oder unbekannte Felder -> leere Liste + Hinweis.
// Jede Empfehlung bekommt Titel, Kategorie der Potenzialbewertung und eine
// Einordnung nach Happy-Property-Regeln (z. B. KI-Funktionen standardmäßig aus).

import { getLastUsage, graphGet, MetaApiError, type GraphParams } from '../_shared/metaGraph.ts'
import {
  FN, graphSeiten, obj, pruefeIds, STOP_PCT, str, uniq, type Ctx, type Raw,
} from './common.ts'
import {
  auslastungMerken, cacheLesen, cacheSchluessel, cacheSchreiben, drosselText, drosselungLesen, drosselungMerken,
  TTL_VERGANGEN_S,
} from './cache.ts'
import { empfehlungInfo, isoZeit, zahlOderNull } from './normalize.ts'
import type { Empfehlung, EmpfehlungenResponse } from './types.ts'

interface Payload { opportunity_score: number | null; items: Empfehlung[]; fetched_at: string; hinweise: string[] }

/** Flacht die verschiedenen Antwortformen zu einzelnen Empfehlungs-Objekten ab. */
export function flachEmpfehlungen(data: Raw[]): Raw[] {
  const out: Raw[] = []
  for (const d of data) {
    const liste = Array.isArray(d.recommendations) ? d.recommendations : obj(d.recommendations) && Array.isArray(obj(d.recommendations)!.data) ? obj(d.recommendations)!.data as unknown[] : null
    if (liste) {
      for (const r of liste) {
        const o = obj(r)
        if (o) out.push(o)
      }
    } else if (d.type || d.recommendation_name || d.recommendation_signature) {
      out.push(d)
    }
  }
  return out
}

export function empfehlungAus(r: Raw): Empfehlung {
  const inhalt = obj(r.recommendation_content) ?? {}
  const typ = str(r.type) ?? str(r.recommendation_name) ?? 'UNBEKANNT'
  const info = empfehlungInfo(typ)
  const ids = Array.isArray(r.object_ids) ? r.object_ids.map(x => String(x)).filter(x => /^[0-9]{3,25}$/.test(x)) : []
  const url = str(r.url)
  return {
    signatur: str(r.recommendation_signature),
    typ,
    titel: info.titel,
    kategorie: info.kategorie,
    stufe: str(r.recommendation_stage),
    ebene: str(r.level),
    object_ids: ids,
    lift_estimate: str(inhalt.lift_estimate) ?? str(r.lift_estimate),
    text: str(inhalt.body) ?? str(r.body),
    punkte: zahlOderNull(inhalt.opportunity_score_lift ?? r.opportunity_score_lift),
    zeit: isoZeit(r.recommendation_time),
    url: url && /^https:\/\/([a-z0-9-]+\.)*(facebook|meta)\.com\//i.test(url) ? url : null,
    hp_hinweis: info.hp,
  }
}

/** Unterfelder ausdrücklich: fields=recommendation_content allein kann die Liste abschneiden */
const EMPF_FELDER =
  'recommendations{recommendation_signature,recommendation_stage,recommendation_time,type,object_ids,url,recommendation_content}'

async function empfehlungenLesen(ctx: Ctx, hinweise: string[]): Promise<Raw[]> {
  const pfad = `act_${ctx.account}/recommendations`
  // 1. Liste mit Unterfeldern (Texte in recommendation_content),
  // 2. fields=recommendation_content (ältere Form),
  // 3. ohne fields (Grundfelder ohne Texte).
  // Nächste Form bei Validierungsfehler ODER wenn Zeilen kommen, aber keine Empfehlung erkennbar ist.
  // locale=de_DE für deutsche Texte; lehnt Meta locale ab, ohne.
  const versuche: GraphParams[] = [{ fields: EMPF_FELDER }, { fields: 'recommendation_content' }, {}]
  let mitLocale = true
  let letzter: unknown = null
  let unbekannteForm = false
  for (let i = 0; i < versuche.length; i++) {
    const p: GraphParams = { ...versuche[i], limit: 100 }
    if (mitLocale) p.locale = 'de_DE'
    try {
      const s = await graphSeiten<Raw>(pfad, p, 3)
      const flach = flachEmpfehlungen(s.rows)
      if (flach.length || !s.rows.length) {
        if (s.grund) hinweise.push(`Empfehlungen: ${s.grund}`)
        return flach
      }
      unbekannteForm = true
      console.warn(`[${FN}] recommendations: ${s.rows.length} Zeilen ohne erkennbare Empfehlung (Variante ${i + 1}), nächste Form`)
    } catch (err) {
      if (!(err instanceof MetaApiError) || err.kind !== 'validation') throw err
      if (mitLocale && /locale/i.test(`${err.message} ${err.userMsg ?? ''}`)) {
        mitLocale = false
        i--
        continue
      }
      letzter = err
    }
  }
  if (unbekannteForm) {
    hinweise.push('Meta liefert Empfehlungen in einer unbekannten Form. Bitte im Werbeanzeigenmanager unter Potenzialbewertung ansehen.')
    return []
  }
  throw letzter
}

export async function modeEmpfehlungen(ctx: Ctx, body: Raw): Promise<EmpfehlungenResponse> {
  const filter = pruefeIds(body.object_ids, 'object_ids', 200, false)
  const key = await cacheSchluessel({ mode: 'empfehlungen', account: ctx.account })
  const treffer = await cacheLesen<Payload>(ctx.sb, key)
  const gueltig = treffer && Array.isArray(treffer.payload?.items) ? treffer : null

  const antwort = (p: Payload, cached: boolean, veraltet: boolean): EmpfehlungenResponse => {
    const items = filter.length ? p.items.filter(i => i.object_ids.some(id => filter.indexOf(id) >= 0)) : p.items
    return {
      opportunity_score: p.opportunity_score,
      items,
      cached,
      fetched_at: p.fetched_at,
      veraltet,
      hinweise: uniq([...(p.hinweise ?? []), ...ctx.hinweise]),
    }
  }
  if (gueltig && gueltig.frisch && body.frisch !== true) return antwort(gueltig.payload, true, false)

  const drossel = await drosselungLesen(ctx.sb, ctx.account)
  if (drossel) {
    ctx.hinweise.push(drosselText(drossel))
    if (gueltig) return antwort(gueltig.payload, true, true)
    return antwort({ opportunity_score: null, items: [], fetched_at: new Date().toISOString(), hinweise: [] }, false, true)
  }

  const hinweise: string[] = []
  let score: number | null = null
  let rohe: Raw[] = []
  let metaFehler: MetaApiError | null = null
  try {
    const acc = await graphGet<Raw>(`act_${ctx.account}`, { fields: 'opportunity_score' })
    score = zahlOderNull(acc?.opportunity_score)
    if (score !== null) score = Math.max(0, Math.min(100, Math.round(score * 10) / 10))
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err
    if (err.kind === 'rate_limit') metaFehler = err
    console.warn(`[${FN}] opportunity_score:`, err.message.slice(0, 200))
  }
  const u = getLastUsage()
  if (!metaFehler && u && u.accUtilPct > STOP_PCT) {
    hinweise.push(`Meta-Auslastung ${Math.round(u.accUtilPct)} %: Empfehlungen nicht abgerufen.`)
  } else if (!metaFehler) {
    try {
      rohe = await empfehlungenLesen(ctx, hinweise)
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err
      if (err.kind === 'rate_limit') metaFehler = err
      else hinweise.push(`Meta liefert für dieses Konto keine Empfehlungen über die API (${(err.userMsg || err.message).slice(0, 140)}).`)
    }
  }
  if (metaFehler) {
    await drosselungMerken(ctx.sb, ctx.account, metaFehler)
    ctx.hinweise.push('Meta drosselt gerade die Abfragen.')
    if (gueltig) return antwort(gueltig.payload, true, true)
    return antwort({ opportunity_score: score, items: [], fetched_at: new Date().toISOString(), hinweise }, false, true)
  }

  const items = rohe.map(empfehlungAus)
    // Doppelte (gleiche Signatur) zusammenfassen, wichtigste zuerst
    .filter((e, i, l) => !e.signatur || l.findIndex(x => x.signatur === e.signatur) === i)
    .sort((a, b) => (b.punkte ?? -1) - (a.punkte ?? -1))
  if (!items.length && !hinweise.length) hinweise.push('Meta meldet derzeit keine Empfehlungen.')
  const payload: Payload = { opportunity_score: score, items, fetched_at: new Date().toISOString(), hinweise }
  await cacheSchreiben(ctx.sb, key, payload, TTL_VERGANGEN_S)
  await auslastungMerken(ctx.sb, ctx.account)
  return antwort(payload, false, false)
}
