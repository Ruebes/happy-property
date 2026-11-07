// Reel auf Instagram veröffentlichen, auf Wunsch als Testreel.
//
// Testreel (crm_settings social_autopilot.trial_reel_ids): läuft zuerst nur bei Nicht-Followern
// und geht bei guter Leistung von selbst ins Profil. Am 7.11.2026 geprüft: Instagram nimmt
// trial_params in v21.0 bei 453 Followern an, ein ungültiger Wert wird abgelehnt.
//
// Lehnt Instagram ein Testreel ab, geht es als normales Reel raus. Der Beitrag darf daran nie
// scheitern. Nach einem späten Fehlschlag (Verarbeitung, Veröffentlichung) legt diese Funktion nur
// den normalen Container an und meldet „wartet". Der nächste Lauf in 30 Minuten schließt ab, so
// bleibt ein Lauf unter der Zeitgrenze der Function.

const G = 'https://graph.facebook.com/v21.0'
const TEST_PARAMS = JSON.stringify({ graduation_strategy: 'SS_PERFORMANCE' })
const FEHLER_VERARBEITUNG = 'Instagram konnte das Video nicht verarbeiten (Format/Länge prüfen: MP4, 9:16, max. 15 Min).'

export interface ReelVorlauf { container?: string; tries?: number; trial?: boolean; trial_fallback?: string }
export interface ReelErgebnis { ok: boolean; id?: string; error?: string; pending?: boolean; container?: string; tries?: number; trial?: boolean; trial_fallback?: string }
export interface ReelAuftrag {
  igId: string
  videoUrl: string
  caption: string
  token: string
  alsTest: boolean                     // gilt nur für den ersten Versuch, danach zählt der Vorlauf
  vorlauf: ReelVorlauf | null          // wartender Versuch aus post_results
  bereinigen: (s: string) => string    // entfernt Zugangsdaten aus Fehlertexten
  warteMs?: number
  fetcher?: typeof fetch
}
type Antwort = { id?: string; status_code?: string; error?: { message?: string } }

// Liefert Erfolg oder „wartet" zurück und wirft bei endgültigem Fehlschlag.
export async function reelPosten(a: ReelAuftrag): Promise<ReelErgebnis> {
  const f = a.fetcher ?? fetch
  const warteMs = a.warteMs ?? 10000

  const container = async (test: boolean): Promise<Antwort> => {
    const felder = new URLSearchParams({ media_type: 'REELS', video_url: a.videoUrl, caption: a.caption, access_token: a.token })
    if (test) felder.set('trial_params', TEST_PARAMS)
    else felder.set('share_to_feed', 'true')
    return await f(`${G}/${a.igId}/media`, { method: 'POST', body: felder }).then(x => x.json())
  }
  const status = async (id: string): Promise<string> => {
    let st = ''
    for (let i = 0; i < 12; i++) {
      await new Promise(res => setTimeout(res, warteMs))
      const r = await f(`${G}/${id}?fields=status_code&access_token=${a.token}`).then(x => x.json()).catch(() => ({})) as Antwort
      st = r.status_code ?? ''
      if (st === 'FINISHED' || st === 'ERROR' || st === 'EXPIRED') break
    }
    return st
  }

  let alsTest = a.vorlauf ? a.vorlauf.trial === true : a.alsTest
  let grund = a.vorlauf?.trial_fallback ?? ''
  let cid = a.vorlauf?.container ?? ''
  const kennung = () => ({ ...(alsTest ? { trial: true } : {}), ...(grund ? { trial_fallback: grund } : {}) })
  const aufNormal = async (warum: string) => {
    grund = a.bereinigen(warum).slice(0, 200)
    alsTest = false
    const c = await container(false)
    if (c.error) throw new Error(c.error.message)
    cid = c.id as string
  }
  const wartet = (): ReelErgebnis => {
    const tries = (a.vorlauf?.tries ?? 0) + 1
    if (tries >= 8) throw new Error('Instagram verarbeitet das Reel seit über 3 Stunden nicht. Bitte manuell posten.')
    return { ok: false, pending: true, container: cid, tries, ...kennung(), error: 'Instagram verarbeitet das Reel noch, nächster Versuch automatisch in 30 Min.' }
  }

  if (!cid) {
    const c = await container(alsTest)
    if (!c.error) cid = c.id as string
    else if (alsTest) await aufNormal(c.error.message ?? 'Testreel abgelehnt')
    else throw new Error(c.error.message)
  }
  const st = await status(cid)
  if (st === 'ERROR' || st === 'EXPIRED') {
    if (!alsTest) throw new Error(FEHLER_VERARBEITUNG)
    await aufNormal(`Testreel-Container: ${st}`)
    return wartet()
  }
  if (st !== 'FINISHED') return wartet()

  const pub = await f(`${G}/${a.igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: cid, access_token: a.token }) }).then(x => x.json()) as Antwort
  if (pub.error) {
    if (!alsTest) throw new Error(pub.error.message)
    await aufNormal(pub.error.message ?? 'Testreel nicht veröffentlicht')
    return wartet()
  }
  return { ok: true, id: pub.id, ...kennung() }
}
