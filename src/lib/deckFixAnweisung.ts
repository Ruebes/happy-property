// ── Anweisung „Im Deck-Chat beheben" ─────────────────────────────────────────
// Baut aus den offenen Befunden der Deck-Prüfung eine Anweisung für den Deck-Chat
// (refine-deck). Seit 12.10.26 schneidet die Autobereinigung keine Sätze mehr aus
// Fließtext heraus; diese Stellen formuliert die KI im Chat um, Sven sieht den
// Text vorher im Eingabefeld und schickt ihn selbst ab (nie automatisch).
//
// Die Anweisung ist IMMER deutsch (Sven 12.10.26), auch bei einem englischen Deck:
// Sie richtet sich an die KI, nicht an den Kunden. Rein, ohne React und ohne Netz,
// getestet in scripts/verify-deck-autofix.mjs (T55).

export interface FixFinding {
  key: string
  severity?: string
  what?: string
  block?: number
  evidence?: string
  sourceA?: string
  /** Behauptungen: die Aussage im Wortlaut (claimIssuesToFindings). */
  claim?: string
  /** flaeche_abweichung: Stammwerte mit Bedeutung („C-105: Innenfläche 84,5 m², Terrasse 16 m², gesamt 100,5 m²"). */
  stamm?: string
  loc?: { field?: string; match?: string }
}

/** Befunde, die sich per Textänderung im Deck-Chat beheben lassen. */
export const CHAT_BEHEBBAR = new Set([
  'behauptung_unsupported', 'behauptung_conflict', 'preis_im_fliesstext', 'betrag_fremd', 'renditeaussage',
  'zimmer_abweichung', 'bad_abweichung', 'etage_abweichung', 'flaeche_abweichung',
])

const ZAHL_KEYS = new Set(['zimmer_abweichung', 'bad_abweichung', 'etage_abweichung', 'flaeche_abweichung'])

/** Weiche Flächenbefunde (mittel: Zahl ausserhalb von Wohnungs- und Grundrissblock, etwa
 *  Grundstück der Anlage oder Penthouse-Terrasse) meldet das Gate nur zum Prüfen. Die KI
 *  soll dort nichts überschreiben: sie gehören nicht in die Anweisung (Prüfbefund 12.10.26). */
const nurPruefen = (f: FixFinding) => f.key === 'flaeche_abweichung' && f.severity !== 'hoch' && f.severity !== 'kritisch'

const einzeilig = (s: string) => s.replace(/\s+/g, ' ').trim()
const kurz = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
/** Gedankenstriche aus Befundtexten in normale Bindestriche (Sven: nie — oder –). */
const ohneStrich = (s: string) => s.replace(/\s*[—–]\s*/g, ' - ')

/** Die beanstandete Stelle im Wortlaut. */
function aussage(f: FixFinding): string {
  if (f.key.startsWith('behauptung_')) {
    const c = f.claim?.trim() || f.what?.replace(/^[^:]*:\s*/, '').trim() || ''
    return c
  }
  if (f.loc?.match) return f.loc.match.trim()
  // Rückfall: Ausschnitt aus evidence („feld: Text ...") ohne Feldpräfix
  const ev = f.evidence?.replace(/^[\w.[\]]+:\s*/, '') ?? ''
  return ev.trim() || f.what?.trim() || ''
}

/** Wert aus den Stammdaten: Gate-Befunde nennen ihn im what („..., in den Stammdaten 2."),
 *  Flächen zusätzlich in sourceA („CRM: 84.5 / 16 m²"), Behauptungen im evidence. */
function stammwert(f: FixFinding): string {
  const w = f.what?.match(/in den Stammdaten\s+(.+?)\.?\s*$/i)?.[1]
  if (w) return w.trim()
  if (f.sourceA) return f.sourceA.replace(/^CRM:\s*/i, '').trim()
  return f.evidence?.trim() ?? ''
}

/** Weiche Befunde (Behauptung oder fremder Betrag unter „hoch") nur zum Pruefen, nicht zum Streichen. */
const weich = (f: FixFinding) => (f.key.startsWith('behauptung_') || f.key === 'betrag_fremd')
  && f.severity !== 'hoch' && f.severity !== 'kritisch'

/** Sprechender Ort statt interner Feldpfad („paragraphs[1]" -> „Anschreiben, Absatz 2"). */
function ortName(field?: string): string {
  if (!field) return ''
  const m = field.match(/^(\w+)(?:\[(\d+)\])?/)
  if (!m) return ''
  const n = m[2] != null ? Number(m[2]) + 1 : null
  const NAMEN: Record<string, string> = {
    paragraphs: 'Absatz', cards: 'Karte', cols: 'Spalte', specs: 'Eckdaten-Zeile', bullets: 'Aufzählungspunkt',
    items: 'Eintrag', groups: 'Gruppe', stats: 'Kennzahl', tagline: 'Unterzeile', note: 'Hinweis',
    text: 'Text', intro: 'Einleitung', quote: 'Zitat', headline: 'Überschrift', title: 'Titel',
  }
  const name = NAMEN[m[1]]
  return name ? (n != null ? `${name} ${n}` : name) : ''
}

function aktion(f: FixFinding): string {
  if (weich(f)) return 'Bitte prüfen, ob das stimmt. Nur wenn nicht belegt: streichen oder belegt formulieren.'
  switch (f.key) {
    case 'behauptung_unsupported':
      return 'Unbelegte Aussage streichen oder durch eine belegte Formulierung ersetzen.'
    case 'behauptung_conflict': {
      const ev = f.evidence ? ` (laut Prüfung: ${kurz(einzeilig(f.evidence), 140).replace(/[\s.]+$/, '')})` : ''
      return `Aussage widerspricht den Stammdaten${ev}. Auf die Stammdaten richtigstellen oder streichen.`
    }
    case 'preis_im_fliesstext':
      return 'Preis aus dem Fließtext nehmen. Die Preisbox bleibt unverändert.'
    case 'betrag_fremd':
      return 'Betrag streichen, er passt zu keinem Preis, keiner Rate und keinem Möbelpaket dieses Decks. Die Preisbox und der Zahlungsplan bleiben unverändert.'
    case 'renditeaussage':
      return 'Rendite- oder Mietertragsangabe streichen. Solche Zahlen gehören nur in den Rendite-Rechner.'
    default: {
      if (f.key === 'flaeche_abweichung') {
        // Mehrere Stammwerte: sagen, welcher wofür steht, nie eine blanke Werteliste.
        if (f.stamm) return `Fläche auf den passenden Wert aus den Stammdaten setzen (${kurz(einzeilig(f.stamm), 200)}). Welcher Wert gilt, zeigt der Satz. Ist das nicht eindeutig, die Angabe streichen.`
        const soll = stammwert(f)
        if (soll.includes('/')) return `Fläche auf den passenden Wert aus den Stammdaten setzen: ${kurz(einzeilig(soll), 80)} (Innenfläche, Terrasse, Grundstück oder Innenfläche plus Terrasse). Ist nicht eindeutig, welcher Wert gemeint ist, die Angabe streichen.`
      }
      if (ZAHL_KEYS.has(f.key)) {
        const soll = stammwert(f)
        return soll
          ? `Zahl auf den Wert aus den Stammdaten setzen: ${kurz(einzeilig(soll), 80)}. Passt der Satz dann nicht mehr, die Angabe streichen.`
          : 'Zahl auf den Wert aus den Stammdaten setzen oder die Angabe streichen.'
      }
      return 'Stelle korrigieren oder streichen.'
    }
  }
}

/** Offene, per Text behebbare Befunde, ohne Doppelte (gleicher Befund, Block, Stelle). */
export function chatBehebbar(findings: FixFinding[]): FixFinding[] {
  const gesehen = new Set<string>()
  const out: FixFinding[] = []
  for (const f of findings ?? []) {
    if (!f || !CHAT_BEHEBBAR.has(f.key) || nurPruefen(f)) continue
    const k = `${f.key}|${f.block ?? ''}|${aussage(f).toLowerCase()}`
    if (gesehen.has(k)) continue
    gesehen.add(k)
    out.push(f)
  }
  return out
}

/** Die vorbefüllte Anweisung für den Deck-Chat, oder '' ohne behebbare Befunde. */
export function baueChatAnweisung(findings: FixFinding[]): string {
  const liste = chatBehebbar(findings)
  if (!liste.length) return ''
  const zeilen = liste.map((f, i) => {
    const wo = [f.block != null ? `Block ${f.block}` : 'Block unbekannt', ortName(f.loc?.field)].filter(Boolean).join(', ')
    const a = aussage(f)
    const zitat = a ? ` „${kurz(einzeilig(a))}“.` : ''
    return ohneStrich(`${i + 1}. ${wo}:${zitat} ${aktion(f)}`)
  })
  return ['Bitte korrigiere nur diese Stellen und ändere sonst nichts am Deck:', ...zeilen].join('\n')
}
