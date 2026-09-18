// Projekt-Koordinaten per Google Places (Text Search) ermitteln.
//
// Hintergrund (Sven 18.9.26, Jelena/Infinity): Ohne latitude/longitude baute
// generate-deck die Karte aus einer Such-Query „<Projekt>, <Ort>, Cyprus". Google
// deutet so eine Query als KATEGORIE-Suche und streut ein halbes Dutzend fremder
// Pins (Friseur, Autohändler, …) über Paphos — im Deck sah das wie „keine Lage"
// aus. 32 Projekte (Olias, Kuutio, Mito Infinity/Paramount/Sea View, …) hatten
// keine Koordinaten, jedes Deck davon war betroffen.
//
// Die Bauträger pflegen ihre Projekte als Google-Orte („QCJF+2XF Mito Infinity",
// „Arbeo Park by Olias Homes"). Wir fragen Places gezielt danach und nehmen einen
// Treffer NUR, wenn sein Name den Projektnamen enthält und er auf Zypern liegt —
// sonst landet der Pin beim Bauträger-Büro oder einem gleichnamigen Museum
// („House of Aion"). Kein Treffer → null, der Aufrufer fällt auf die Adresse zurück.

export type GeocodeHit = { lat: number; lng: number; name: string; address: string; mapsUrl: string; query: string }

// Zypern (grob): Treffer außerhalb sind immer falsch.
const IN_CYPRUS = (lat: number, lng: number) => lat > 34.4 && lat < 35.8 && lng > 32.1 && lng < 34.7

// Namen vergleichbar machen: Plus-Codes („QCJF+2XF"), Bauträger-Zusätze („by Olias
// Homes"), Ortsanhänge nach „ - " und Sonderzeichen entfernen.
function norm(s: string): string {
  return s.toLowerCase()
    .replace(/\b[a-z0-9]{4,}\+[a-z0-9]{2,}\b/gi, ' ')   // Plus-Code
    .replace(/[^a-z0-9äöüß ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function projectKey(name: string): string {
  // „Lazzero Park - Kato Paphos" → „lazzero park"; „Tenera Villas (Kuutio)" → „tenera villas"
  return norm(name.split(/\s[-–]\s/)[0].replace(/\(.*?\)/g, ''))
}
function nameMatches(projectName: string, developer: string, hitName: string): boolean {
  const key = projectKey(projectName)
  const hit = norm(hitName)
  if (!key || !hit) return false
  const devKey = norm(developer).split(' ')[0] ?? ''          // „Kuutio Homes" → „kuutio"
  // Fremder Bauträger im Ortsnamen („Pine Park (by Olias Homes)" für Kuutios Pine
  // Park) → falscher Ort, auch wenn der Projektname passt.
  const by = hit.match(/\bby\s+([a-z0-9äöüß]+)/)
  if (by && devKey && !by[1].startsWith(devKey.slice(0, 4))) return false
  const words = key.split(' ').filter(w => w.length >= 3)
  const contains = hit.includes(key) || (words.length > 0 && words.every(w => hit.includes(w)))
  if (!contains) return false
  // Einwort-Namen (AION, Atrium, Gallery, Noble …) kollidieren mit Museen, Hotels,
  // Läden: dann muss der Bauträger im Ortsnamen stehen („Mito Infinity", „Atrium -
  // BY KUUTIOHOMES") oder der Ort exakt so heißen wie das Projekt.
  if (words.length <= 1) return hit === key || (!!devKey && hit.includes(devKey))
  return true
}

type Place = { name: string; address: string; lat: number; lng: number }

// Googles KEYLESS Embed-Endpunkt (derselbe Trick wie place-search/scrapeMaps):
// server-gerendert, löst freie Suchen in echte Orte mit Name, Adresse und
// Koordinaten auf — ohne Places-API. Der hinterlegte GOOGLE_API_KEY ist für
// Places NICHT freigeschaltet („API key not valid", 18.9.26), deshalb bewusst
// kein API-Aufruf. Bei Kategorie-Treffern kommen mehrere Orte zurück; alle
// werden geliefert, der Aufrufer filtert per Namensabgleich.
async function embedSearch(query: string): Promise<Place[]> {
  const r = await fetch(`https://www.google.com/maps/embed?origin=mfe&pb=!1m2!2m1!1s${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Cookie: 'CONSENT=YES+cb; SOCS=CAI',
    },
  })
  if (!r.ok) { console.warn('[geocodeProject] embed', r.status, query); return [] }
  const html = await r.text()
  const out: Place[] = []
  for (const m of html.matchAll(/\["0x[0-9a-f]+:0x[0-9a-f]+","((?:[^"\\]|\\.)*)",\[(-?\d+\.\d+),(-?\d+\.\d+)\]/g)) {
    let display = ''
    try { display = JSON.parse(`"${m[1]}"`) as string } catch { continue }
    out.push({ name: display.split(',')[0].trim(), address: display, lat: Number(m[2]), lng: Number(m[3]) })
  }
  return out
}

// Reihenfolge der Versuche: erst der Google-Ort des Bauträgers, dann Name + Ort.
// Der Bauträger-Kurzname („Kuutio Homes" → „Kuutio") hilft Google beim Matchen.
export async function geocodeProject(p: { name?: string | null; developer?: string | null; location?: string | null }): Promise<GeocodeHit | null> {
  const name = (p.name ?? '').trim()
  if (!name) return null
  const dev = (p.developer ?? '').trim()
  const devShort = dev.split(/\s+/)[0] ?? ''
  const base = projectKey(name)
  const loc = (p.location ?? '').replace(/,?\s*(zypern|cyprus)\s*$/i, '').trim()
  const queries = Array.from(new Set([
    dev ? `${dev} ${base} Paphos` : '',
    devShort && devShort !== dev ? `${devShort} ${base} Paphos` : '',
    loc ? `${base} ${loc}` : '',
    `${base} Paphos Cyprus`,
  ].filter(Boolean)))
  for (const q of queries) {
    let places: Place[] = []
    try { places = await embedSearch(q) } catch (e) { console.warn('[geocodeProject]', q, e); continue }
    for (const pl of places) {
      if (!IN_CYPRUS(pl.lat, pl.lng)) continue
      if (!nameMatches(name, dev, pl.name)) continue
      return { lat: pl.lat, lng: pl.lng, name: pl.name, address: pl.address, query: q,
        mapsUrl: `https://www.google.com/maps?q=${pl.lat},${pl.lng}` }
    }
  }
  return null
}

// Fallback-Suchtext für das keyless Maps-Embed, wenn keine Koordinaten bekannt
// sind: NUR Adresse/Ort, NIE „Projektname, Ort" — der Name macht daraus eine
// Kategorie-Suche mit fremden Pins. Ohne Ort bleibt „<Name> Paphos".
export function mapQueryFallback(p: { name?: string | null; location?: string | null }): string {
  const loc = (p.location ?? '').replace(/,?\s*(zypern|cyprus)\s*$/i, '').trim()
  const name = (p.name ?? '').trim()
  if (loc) return `${loc}, Cyprus`                                     // Straßenadresse oder Ortsteil
  return `${name ? name + ' ' : ''}Paphos, Cyprus`
}
