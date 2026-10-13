// Bausteine des Infopakets, gemeinsam genutzt von info-paket (automatische Mail)
// und anfrage-paket (fertiger Entwurf im Postausgang, Sven 13.10.26): Rechnungs-
// Annahmen aus Svens eigenen Rechnungen, saubere Baustellenfotos, Mail-Karten.
// Reine Verschiebung aus info-paket/index.ts, Verhalten unverändert.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { CI } from '../_shared/brand.ts'
import { callAnthropic, textOf } from '../_shared/anthropic.ts'
import { zahlungsUebersicht } from './datenblatt.ts'

// Über portal.happy-property.com (Vercel-Rewrite auf Supabase Storage, Sven 11.10.26).
export const GUIDE_URL = 'https://portal.happy-property.com/immobilienguide-paphos-2026.pdf'
export const LOGO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
export const PHOTO_SQ = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg?width=112&height=112&resize=cover&quality=80'
export const SERIF = "'Playfair Display',Georgia,serif", SANS = "'Montserrat',Helvetica,Arial,sans-serif"

// Standardannahmen der Rechnung = Svens Wizard-Stand vom Oktober 2026
// (Kurzzeitvermietung, Zins 3,8 %, 5,5 % Bruttomietrendite). Eigenkapital als
// Anteil vom Bruttopreis: mit 0 € (Svens Wizard-Wert) zeigte die Rechnung eine
// Eigenkapitalrendite von über 10.000 %, das wirkt bei einem Erstkontakt unseriös.
// Überschreibbar ohne Deploy über crm_settings.info_paket_calc (JSON, nur diese Felder).
export const CALC_STANDARD = {
  letType: 'short', fin: 'yes', equityPct: 30, interestPct: 3.8, termYears: 20, amortPct: 2,
  yieldPct: 5.5, mgmtPct: 20, rentGrowth: 5, appreciationPct: 5, deTaxPct: 45, res: 'de',
}
export type CalcStandard = typeof CALC_STANDARD

// Markt-Annahmen aus Svens eigenen Rechnungen (Sven 11.10.26: „die Zahlen zu Rate
// ziehen, die wir für diese Projekte und Wohnungen genutzt haben"). Reihenfolge:
// dieselbe Wohnung, sonst gleiches Projekt mit gleicher Zimmerzahl, sonst Standard.
// Übernommen wird nur, was an der Wohnung hängt (Vermietungsart, Rendite, Saison,
// Hotelkonzept, Wertsteigerung, Mietsteigerung). Finanzierung und Steuer hängen
// am Kunden und bleiben Standard. Verwaltung immer 20 % (Svens Agentur, 11.10.26). Rechnungen aus dem Infopaket
// selbst zählen nicht, sonst bestätigt sich der Standard immer wieder selbst.
export interface Markt {
  letType: 'short' | 'long'; yieldPct: number; season: Record<string, unknown> | null; hotelConcept: boolean
  appreciationPct: number; rentGrowth: number; mgmtPct: number; quelle: 'wohnung' | 'projekt' | 'standard'; datum: string | null
}
export type CalcItemRow = { project?: string; unit?: string; bedrooms?: number | string | null; params?: Record<string, unknown> }
export async function marktAnnahmen(sb: SupabaseClient, projekt: string, nr: string, bedrooms: number | null, std: CalcStandard): Promise<Markt> {
  const standard: Markt = {
    letType: std.letType === 'long' ? 'long' : 'short', yieldPct: std.yieldPct, season: null, hotelConcept: false,
    appreciationPct: std.appreciationPct, rentGrowth: std.rentGrowth, mgmtPct: std.mgmtPct, quelle: 'standard', datum: null,
  }
  if (!projekt) return standard
  const seit = new Date(Date.now() - 180 * 86400e3).toISOString()
  const { data } = await sb.from('property_calculations').select('content, created_at')
    .filter('content->items', 'cs', JSON.stringify([{ project: projekt }]))
    .gte('created_at', seit).order('created_at', { ascending: false }).limit(60)
  const rows = (data ?? []) as { content: { source?: string; items?: CalcItemRow[] } | null; created_at: string }[]
  const alle = rows.filter(r => r.content?.source !== 'info_paket')
    .flatMap(r => (r.content?.items ?? []).filter(i => i.project === projekt && i.params).map(i => ({ i, datum: r.created_at })))
  const norm = (x: unknown) => String(x ?? '').trim().toLowerCase()
  const gleicheWohnung = nr ? alle.find(k => norm(k.i.unit) === norm(nr)) : undefined
  const gleicheGroesse = bedrooms != null ? alle.find(k => Number(k.i.bedrooms) === bedrooms) : undefined
  const t = gleicheWohnung ?? gleicheGroesse
  if (!t) return standard
  const p = t.i.params ?? {}
  const letType: 'short' | 'long' = p.letType === 'long' ? 'long' : 'short'
  const hotel = letType === 'short' && p.hotelConcept === true
  const zahl = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  // Verwaltung nie aus alten Rechnungen: Kurzzeit 20 % (Svens Agentur), Langzeit
  // ca. 4 % (Sven 11.10.26, wie defaultMgmtPct im Rechner).
  const mgmtPct = letType === 'long' ? 4 : std.mgmtPct
  const season = letType === 'short' && p.season && typeof p.season === 'object' ? p.season as Record<string, unknown> : null
  return {
    letType, yieldPct: zahl(p.yieldPct, std.yieldPct), season, hotelConcept: hotel,
    appreciationPct: zahl(p.appreciationPct, std.appreciationPct), rentGrowth: zahl(p.rentGrowth, std.rentGrowth), mgmtPct,
    quelle: gleicheWohnung ? 'wohnung' : 'projekt', datum: t.datum,
  }
}

// Vollständiger Parametersatz wie ihn der Wizard speichert (Rechnung.tsx rechnet
// item.params direkt, ohne Defaults einzumischen - deshalb ALLE Felder).
export function eigenkapital(s: CalcStandard, gross: number): number {
  return s.fin === 'yes' ? Math.round(gross * Math.max(0, Math.min(100, s.equityPct)) / 100 / 1000) * 1000 : gross
}
export function calcParams(s: CalcStandard, m: Markt, fin: 'yes' | 'no', priceNet: number, furnCost: number, furnFree: boolean, bedrooms: number | null) {
  const brutto = Math.round((priceNet + (furnFree ? 0 : furnCost)) * 1.19)
  return {
    fin, res: s.res, cyBI: 0, gesy: true, mode: 'ann', year: new Date().getFullYear(), month: 6,
    sdNum: 3, sdSqm: 250, years: 10, equity: fin === 'yes' ? eigenkapital(s, brutto) : brutto, holder: 'privat', ppVals: Array(10).fill(0), sdTerr: 60,
    season: m.season, letType: m.letType, mgmtFix: 0, mgmtPct: m.mgmtPct, sdPrice: 1000000, sdUnits: [],
    vatMode: 'standard19', amortPct: s.amortPct, bedrooms: bedrooms ?? 2, deTaxPct: s.deTaxPct, dealType: 'single',
    furnCost, furnFree, maintPct: 0, mgmtMode: 'pct', priceNet, yieldPct: m.yieldPct, divTaxPct: 26.375,
    livingSqm: null, monthPlan: null, sdTaxRate: 15, socialIns: true, termYears: s.termYears, corpTaxPct: 15,
    rentGrowth: m.rentGrowth, sdDiscount: 0, sdVatDrawn: 0, sdVatYears: 0, discountPct: 0,
    interestPct: s.interestPct, opexMonthly: 0, sdInputMode: 'manual', divPayoutPct: 100,
    hotelConcept: m.hotelConcept, selfUseMonths: 0, appreciationPct: m.appreciationPct,
  }
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const eur = (n: number) => `${Math.round(n).toLocaleString('de-DE')} €`
// ── Baustellenfotos für Interessenten (Sven 11.10.26, feste Regel) ──────────
// „Keine hässlichen Dinge auf Fotos an potentielle Kunden. Nimm ein Bild, auf dem
// das nicht zu sehen ist. IMMER." Nichts wird retuschiert: Ein Foto ist geeignet
// oder es fällt weg. Urteile stehen in crm_settings.kundenfotos
// ({ <file_path>: { ok, grund, von, am } }); von = 'sven' | 'claude' schlägt die KI.
// Neue Fotos prüft die KI einmal (im Zweifel ungeeignet), das Urteil bleibt stehen.
export type FotoUrteil = { ok: boolean; grund?: string; von?: string; am?: string }
export const FOTO_PROMPT = `Du prüfst ein Baustellenfoto, das an Interessenten für eine Neubauwohnung geht. Svens Regel: Auf dem Foto darf nichts Unschönes zu sehen sein.
Ungeeignet, sobald etwas davon erkennbar ist: alte, heruntergekommene oder unverputzte Nachbargebäude, Graffiti, Müll, Schutthaufen, Reifen, kaputte Zäune, Planen, fremde Werbeschilder groß im Bild, erkennbare Personen, dunkles, schiefes oder verwackeltes Bild.
In Ordnung sind normale Baustellenteile: Erdaushub und Erdhügel, Bagger, Beton, Bewehrung, Schalung, Kran, Betonpumpe, Gerüst, ordentlich gelagertes Material, ein Bauzaun am Rand, moderne oder gepflegte Nachbargebäude, Himmel. Entscheidend ist der Gesamteindruck: sauberer Baufortschritt ja, Verwahrlosung nein.
Im Zweifel: ungeeignet.
Antworte nur mit JSON: {"geeignet": true oder false, "grund": "max. 12 Wörter"}`
export async function fotoPruefen(url: string): Promise<FotoUrteil | null> {
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  const res = await callAnthropic(key, {
    model: 'claude-opus-5-5', fallbackModels: ['claude-sonnet-4-6'], max_tokens: 4000, label: 'info-paket-foto',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url } },
      { type: 'text', text: FOTO_PROMPT },
    ] }],
  })
  if (!res.ok || res.stop_reason === 'refusal') return null
  const m = textOf(res).match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { geeignet?: boolean; grund?: string }
    return { ok: j.geeignet === true, grund: String(j.grund ?? '').slice(0, 120), von: 'ki', am: new Date().toISOString() }
  } catch { return null }
}
export async function kundenFotos(sb: SupabaseClient, projectId: string): Promise<{ fotos: string[]; fotoStand: string }> {
  const { data: ph } = await sb.from('construction_photos').select('file_path, photo_date')
    .eq('project_id', projectId).order('photo_date', { ascending: false, nullsFirst: false }).limit(8)
  const rows = (ph ?? []) as { file_path: string; photo_date: string | null }[]
  if (!rows.length) return { fotos: [], fotoStand: '' }
  const { data: st } = await sb.from('crm_settings').select('value').eq('key', 'kundenfotos').maybeSingle()
  let urteile: Record<string, FotoUrteil> = {}
  try { urteile = JSON.parse((st as { value?: string } | null)?.value ?? '{}') } catch { urteile = {} }
  const signed = async (path: string, w: number, h: number) => (await sb.storage.from('construction-photos')
    .createSignedUrl(path, 180 * 86400, { transform: { width: w, height: h, resize: 'cover', quality: 75 } })).data?.signedUrl ?? null
  const gewaehlt: { url: string; datum: string | null }[] = []
  let neu = false, geprueft = 0
  for (const r of rows) {
    if (gewaehlt.length >= 2) break
    let u = urteile[r.file_path]
    // Höchstens 3 KI-Prüfungen je Anfrage, damit der Kunde nicht wartet.
    if (!u && geprueft < 3) {
      geprueft++
      const prev = await signed(r.file_path, 1000, 750)
      const k = prev ? await fotoPruefen(prev) : null
      if (k) { u = k; urteile[r.file_path] = k; neu = true }
    }
    if (!u?.ok) continue
    const url = await signed(r.file_path, 560, 420)
    if (url) gewaehlt.push({ url, datum: r.photo_date })
  }
  if (neu) {
    await sb.from('crm_settings').upsert({ key: 'kundenfotos', value: JSON.stringify(urteile), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  const dt = gewaehlt[0]?.datum
  const fotoStand = dt ? new Date(`${dt}T12:00:00`).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
  return { fotos: gewaehlt.map(g => g.url), fotoStand }
}

export function karte(icon: string, titel: string, text: string, knopf: string, url: string): string {
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">${icon} ${esc(titel)}</p>
      <p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">${text}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${CI.coral};border-radius:999px;padding:11px 20px;">
          <a href="${esc(url)}" style="font-family:${SANS};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(knopf)} &rarr;</a>
        </td></tr></table>
    </td></tr>
  </table>
</td></tr>`
}

export const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} %`
export function knopf(text: string, url: string, farbe: string): string {
  return `<td style="background:${farbe};border-radius:999px;padding:11px 18px;"><a href="${esc(url)}" style="font-family:${SANS};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">${esc(text)} &rarr;</a></td>`
}
export function rechnungKarte(m: { gross: number; calcUrl: string; calcUrlCash: string; terminUrl: string; std: CalcStandard; markt: Markt }): string {
  const k = m.markt
  const vermietung = k.letType === 'long' ? 'Langzeitvermietung' : k.hotelConcept ? 'Kurzzeitvermietung mit Hotelkonzept' : 'Kurzzeitvermietung'
  const rendite = k.season ? 'Mieteinnahmen nach Saisonmodell' : `${pct(k.yieldPct)} Bruttomietrendite`
  const annahmen = `Annahmen: ${vermietung}, ${rendite}, Verwaltung ${pct(k.mgmtPct)}, Wertsteigerung ${pct(k.appreciationPct)} pro Jahr. Variante mit Finanzierung: ${m.std.equityPct} % Eigenkapital, ${pct(m.std.interestPct)} Zins, ${m.std.termYears} Jahre.`
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">📊 Deine persönliche Kosten- und Mietrechnung</p>
      <p style="margin:0 0 10px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">Bruttokaufpreis ${eur(m.gross)}. Ich habe dir zwei Varianten gerechnet: einmal finanziert, einmal ohne Kredit. Beide mit Nebenkosten, Mieteinnahmen${k.letType === 'short' ? ', MwSt-Erstattung' : ''} und Cashflow über 10 Jahre.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${knopf('Mit Finanzierung', m.calcUrl, CI.coral)}<td style="width:10px;font-size:0;">&nbsp;</td>${knopf('Ohne Kredit', m.calcUrlCash, CI.navy)}
      </tr></table>
      <p style="margin:14px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${CI.mute};">${esc(annahmen)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
        <td style="background:${CI.coralSoft};border-radius:10px;padding:14px 16px;">
          <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};"><strong>Genauere Zahlen bekommst du, sobald ich dein Eigenkapital und deine Steuersituation kenne.</strong> Das klären wir am besten in einem kurzen Gespräch, dann rechne ich dir deine Variante genau durch. <a href="${esc(m.terminUrl)}" style="color:${CI.navy};font-weight:700;">Termin aussuchen</a></p>
        </td></tr></table>
    </td></tr>
  </table>
</td></tr>`
}

// Zahlungsplan als eigener Punkt (Sven 11.10.26): fett, dass jetzt nur Reservierung
// und Kaufvertrag fällig sind, darunter der Link zum kompletten Zahlungsplan.
export function zahlungKarte(z: ReturnType<typeof zahlungsUebersicht>, url: string | null): string {
  if (!z) return ''
  // Zeitpunkt als Satzteil: „bei Übergabe, geplant Ende 2027" -> „bei Übergabe (geplant Ende 2027)",
  // „im Laufe von 2028, in Raten" -> „in Raten im Laufe von 2028".
  const satz = (w: string | null) => !w ? 'später' : w
    .replace(/^im Laufe von (\d{4}), in Raten$/, 'in Raten im Laufe von $1')
    .replace(/^nach Baufortschritt, /, 'nach Baufortschritt ')
    .replace(/, geplant (.+)$/, ' (geplant $1)')
  const jetzt = z.jetzt.map(j => /reserv/i.test(j.label)
    ? `${esc(j.value)} für die Reservierung`
    : /vertrag/i.test(j.label)
      ? `in ca. 2 bis 4 Wochen ${esc(j.value)}${j.pct ? ` (${esc(j.pct)} %)` : ''} bei Vertragsunterzeichnung`
      : `${esc(j.value)} ${esc(j.label)}`)
  const liste = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} und ${xs[xs.length - 1]}`
  const fett = jetzt.length === 1 ? `Jetzt fällig ist nur ${jetzt[0]}.`
    : jetzt.length === 2 ? `Jetzt fällig sind nur zwei Zahlungen: ${jetzt[0]} und ${jetzt[1]}.`
    : `Jetzt fällig sind nur: ${liste(jetzt)}.`
  // Gleiche Zeitpunkte zusammenfassen (drei Bauraten = ein Satzteil mit Summe).
  const zahl = (v: string) => Number(v.replace(/[^\d]/g, '')) || 0
  const gruppen: { wann: string | null; summe: number; anzahl: number; value: string }[] = []
  for (const r of z.spaeter) {
    const g = gruppen.find(x => x.wann === r.wann)
    if (g) { g.summe += zahl(r.value); g.anzahl++ } else gruppen.push({ wann: r.wann, summe: zahl(r.value), anzahl: 1, value: r.value })
  }
  const teil = (g: typeof gruppen[number]) => g.anzahl > 1
    ? `${eur(g.summe)} in ${g.anzahl} Raten ${esc(satz(g.wann))}`
    : `${esc(g.value)} ${esc(satz(g.wann))}`
  const rest = gruppen.length ? `Alles Weitere kommt erst später: ${liste(gruppen.map(teil))}.` : ''
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px;">
      <p style="margin:0 0 8px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">💶 Dein Zahlungsplan</p>
      <p style="margin:0 0 10px;font-family:${SANS};font-size:15px;line-height:1.6;color:${CI.ink};"><strong>${fett}</strong></p>
      ${rest ? `<p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">${rest}</p>` : ''}
      ${url ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${knopf('Kompletten Zahlungsplan ansehen', url, CI.coral)}</tr></table>` : ''}
    </td></tr>
  </table>
</td></tr>`
}

