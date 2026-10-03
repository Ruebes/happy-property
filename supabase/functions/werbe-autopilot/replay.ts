// Aktion replay {von, bis}: NUR LESEND. Bewertet die Regeln nachträglich über die
// vorhandenen ad_quality_daily-Zeilen der Stichtage von..bis (höchstens 14 Tage)
// und gibt eine JSON-Zusammenfassung zurück. Schreibt nichts (kein Log, keine
// Aktionen, kein werbe_qualitaet_berechnen).
//
// Näherung, bitte so lesen:
//   - Regeln und Einstellungen sind die HEUTIGEN (nicht die damaligen).
//   - Lauf-Zeitpunkt = Stichtag + 1 Tag, 05:00 Uhr Berlin.
//   - Vorrat ist der heutige Stand.
//   - Freie Termin-Slots sind unbekannt (S1 bleibt gesperrt, D3 meldet nichts).
//   - Sync gilt als aktuell, Meta-/CAPI-Fehler werden nicht nachgestellt.
//   - Modus 'aus' wird für den Replay als 'schatten' gerechnet.

import { bewerteRegeln, type RegelKontext } from '../_shared/werbeRegeln.ts'
import { datumPlus, tageZwischen } from '../_shared/werbeMathe.ts'
import { type Sb, berlinMitternacht } from './gemeinsam.ts'
import {
  INSIGHT_TAGE, ersterInsightTag, kontoAusTagen, ladeAktionen, ladeEinstellungen, ladeFruehphase,
  ladeInsights, ladeKonto, ladeLog, ladeQualitaet, ladeRegeln, ladeSnapshots, ladeVorrat, ladeWriteLog, sichereStarts,
} from './kontext.ts'

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/
export const REPLAY_MAX_TAGE = 14

export async function replay(sb: Sb, body: Record<string, unknown>, now: Date): Promise<Record<string, unknown>> {
  const von = String(body.von ?? '').slice(0, 10)
  const bis = String(body.bis ?? body.von ?? '').slice(0, 10)
  if (!DATUM_RE.test(von) || !DATUM_RE.test(bis) || bis < von) {
    return { success: false, error: 'von und bis als YYYY-MM-DD angeben (bis >= von).' }
  }
  if (tageZwischen(von, bis) + 1 > REPLAY_MAX_TAGE) {
    return { success: false, error: `Höchstens ${REPLAY_MAX_TAGE} Stichtage je Replay.` }
  }

  const { settings, modus } = await ladeEinstellungen(sb)
  const replaySettings = { ...settings, autopilot_mode: modus === 'aus' ? 'schatten' as const : modus }
  const { regeln, parameter, verwaltet } = await ladeRegeln(sb)
  const vorrat = await ladeVorrat(sb)

  // Einmal für den ganzen Zeitraum laden, je Tag in-memory schneiden
  const runVon = datumPlus(von, 1)
  const runBis = datumPlus(bis, 1)
  const snapsAlle = await ladeSnapshots(sb, datumPlus(runVon, -3), runBis)
  const aktiv = new Set<string>()
  for (const z of snapsAlle.zeilen) if (z.entity_level === 'ad' && z.status === 'ACTIVE') aktiv.add(z.entity_id)
  const ladeAb = datumPlus(runVon, -INSIGHT_TAGE)
  const datenBeginn = await ersterInsightTag(sb)
  const insightsAb = datenBeginn && datenBeginn > ladeAb ? datenBeginn : ladeAb
  const insightsAlle = aktiv.size ? await ladeInsights(sb, [...aktiv], ladeAb, bis) : []
  const abIso = new Date(berlinMitternacht(runVon) - 14 * 86400000).toISOString()
  const bisIso = new Date(berlinMitternacht(datumPlus(runBis, 1))).toISOString()
  const aktionenAlle = await ladeAktionen(sb, abIso, bisIso)
  const logAlle = await ladeLog(sb, abIso, bisIso)
  const wl = await ladeWriteLog(sb, abIso, bisIso, bisIso)
  const kt = await ladeKonto(sb, runBis, [`${runVon.slice(0, 7)}-01`, datumPlus(runVon, -8)].sort()[0])

  const tage: Array<Record<string, unknown>> = []
  for (let stichtag = von; stichtag <= bis; stichtag = datumPlus(stichtag, 1)) {
    const lauftag = datumPlus(stichtag, 1)
    const t = berlinMitternacht(lauftag) + 5 * 3600000
    if (t > now.getTime()) break
    const tIso = new Date(t).toISOString()
    const qual = await ladeQualitaet(sb, stichtag, true)
    if (!qual.zeilen.length) {
      tage.push({ stichtag, lauftag, uebersprungen: 'keine Qualitätszeilen für diesen Stichtag' })
      continue
    }
    const snaps = snapsAlle.zeilen.filter(z => z.snap_date >= datumPlus(lauftag, -3) && z.snap_date <= lauftag)
    const insights = insightsAlle.filter(r => r.day < lauftag)
    const fruehphase = await ladeFruehphase(sb, sichereStarts(insights, insightsAb), stichtag)
    const ab = t - 14 * 86400000
    const imFenster = (iso: string | null | undefined) => {
      const x = iso ? Date.parse(iso) : NaN
      return Number.isFinite(x) && x >= ab && x < t
    }
    const k = kontoAusTagen(kt.tage, lauftag)
    const ctx: RegelKontext = {
      now: t,
      settings: replaySettings,
      rules: regeln,
      qualitaet: qual.zeilen,
      snapshots: snaps,
      insights,
      insights_ab: insightsAb,
      fruehphase,
      aktionen: aktionenAlle.filter(a => imFenster(a.created_at)),
      log: logAlle.filter(l => imFenster(l.ts)),
      eigene_writes: wl.eigene.filter(w => imFenster(w.ts)),
      vorrat,
      freie_slots_7d: null,
      fx: k.fx,
      konto: k.konto,
      sync: { letzter_erfolg: new Date(t - 3600000).toISOString() },
      meta_fehler: [],
      capi_laeufe: [],
      verwaltete_kampagnen: verwaltet,
      parameter,
    }
    const erg = bewerteRegeln(ctx)
    const nachRegel: Record<string, number> = {}
    const nachStufe: Record<string, number> = {}
    for (const v of erg.vorschlaege) {
      nachRegel[v.rule_key] = (nachRegel[v.rule_key] ?? 0) + 1
      nachStufe[String(v.stufe)] = (nachStufe[String(v.stufe)] ?? 0) + 1
    }
    const hinweise: Record<string, number> = {}
    for (const h of erg.hinweise) hinweise[h.code] = (hinweise[h.code] ?? 0) + 1
    tage.push({
      stichtag, lauftag, lauf_zeitpunkt: tIso,
      snapshots: snaps.length, qualitaetszeilen: qual.zeilen.length,
      vorschlaege: erg.vorschlaege.length, nach_regel: nachRegel, nach_stufe: nachStufe,
      stopps: erg.stopps.map(s => ({ code: s.code, text: s.text })),
      hinweise,
      info: erg.info,
      beispiele: erg.vorschlaege.slice(0, 12).map(v => ({
        rule_key: v.rule_key, aktion: v.aktion, entity_level: v.entity_level, entity_id: v.entity_id,
        entity_name: v.entity_name, stufe: v.stufe, grund: v.grund, before: v.before, after: v.after,
      })),
    })
  }

  return {
    success: true,
    modus: 'replay',
    nur_lesend: true,
    hinweis: 'Nur lesend: rechnet mit den heutigen Regeln, Einstellungen und dem heutigen Vorrat über die gespeicherten Qualitätszeilen. Freie Slots unbekannt (S1 gesperrt), Sync gilt als aktuell, Meta-/CAPI-Fehler nicht nachgestellt. Es wurde nichts geschrieben.',
    modus_echt: modus,
    modus_replay: replaySettings.autopilot_mode,
    von, bis,
    tage,
  }
}
