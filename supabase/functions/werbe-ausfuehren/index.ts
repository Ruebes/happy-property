// Edge Function: werbe-ausfuehren
// Der EINZIGE Meta-Schreiber des Werbe-Autopiloten. Führt freigegebene Vorschläge aus
// (ad_actions), lädt freigegebene Werbemittel aus dem Vorrat als PAUSIERTE Anzeigen hoch
// und nimmt ausgeführte Aktionen zurück. Der eigentliche Ausführer (Claim, Ablauf,
// Vorher-Hash, Leitplanken, Rücklesen, Log, Gruppen-Rücksetzung) steht in
// _shared/werbeAusfuehren.ts; werbe-autopilot selbst schreibt nie an Meta.
//
// Body (JSON, Feld modus; mode/aktion werden als Alias gelesen):
//   { modus: 'freigabe', gruppe_id }   Gruppe ausführen, die per RPC werbe_vorschlag_entscheiden
//                                      freigegeben wurde (Ein-Klick in der Oberfläche; Sven ODER
//                                      Giona). Alternativ ids: uuid[].
//   { modus: 'fenster' }               alle bestätigten Autopilot-Zeilen (Änderungsfenster-Lauf,
//                                      werbe-autopilot nacht/nachholen, pg_cron)
//   Freigegebene ersatz_hochladen-Gruppen gibt der Ausführer als delegiert zurück (Claim
//   gehalten); sie laufen hier über hochladen.ts (hochladenAusAktionen, payload.pool_id,
//   payload.adset_id) und werden danach abgeschlossen.
//   { modus: 'validieren', gruppe_id } Leitplanken + execution_options validate_only bei Meta,
//                                      ändert nichts (auch für noch nicht freigegebene Vorschläge);
//                                      ersatz_hochladen-Zeilen: übersprungen 'nur_bei_ausfuehrung'
//   { modus: 'rueckgaengig', action_id, grund? }
//                                      Gegenaktion zu einer ausgeführten Zeile (pause <-> activate,
//                                      budget_set auf den Vorher-Wert), siehe rueckgaengig.ts
//   { modus: 'hochladen', pool_id, nur_validieren? }
//                                      freigegebenes Werbemittel -> Creative + Anzeige(n) PAUSED je
//                                      Ziel-Anzeigengruppe, zuerst validate_only, siehe hochladen.ts
// Antwort: { success, ausgefuehrt, fehlgeschlagen, uebersprungen: [{id, grund}], gestoppt?,
//            abgebrochen?, validiert? } bzw. die Felder des Modus. Hat der Lauf den Autopiloten
//            gestoppt (gestoppt gesetzt), geht sofort eine kurze Mail an sven@happy-property.com.
//
// Aufrufer (Guard wie gateCaller mit { cron, service, roles: admin/verwalter, perms: werbung }):
//   pg_cron (x-cron-secret), andere Functions (Service-Key in Authorization oder apikey),
//   eingeloggte admin/verwalter und mitarbeiter mit Recht werbung (Giona). Schreibende Modi
//   (freigabe, fenster, hochladen, rueckgaengig) zusätzlich nur mit vollem Recht werbung
//   (darfSchreiben, wie current_user_has_perm('werbung')); validieren reicht der Guard.
//   authorizeCaller statt gateCaller, weil der Ausführer die Nutzer-ID braucht (akteur,
//   approved_by); die apikey-Regel von gateCaller ist unten nachgebaut. Kein Beobachtungsmodus.
//
// Not-Aus: Secret META_WRITES_DISABLED=1 sperrt jeden Schreibzugriff (graphPost/uploadImage
// werfen; freigabe/fenster brechen mit abgebrochen='META_WRITES_DISABLED' ab, Zeilen bleiben).
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync" (ads_management)
//   META_AD_ACCOUNT_ID  = 4065490590399677 (Standard im Code)
//   META_PAGE_ID        = 556440087559971 (Standard; ad_settings.default_page_id hat Vorrang)
//   META_GRAPH_VERSION  = optional, Form vNN.0 (Standard v25.0)
//   META_WRITES_DISABLED = 1 sperrt alle Meta-Schreibzugriffe
//
// ── Deployment ──
//   supabase functions deploy werbe-ausfuehren --no-verify-jwt
//   (config.toml: [functions.werbe-ausfuehren] verify_jwt = false; Schutz im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, safeEqual, type Caller, type CallerRule } from '../_shared/callerAuth.ts'
import { ausfuehren, type AusfuehrenErgebnis } from '../_shared/werbeAusfuehren.ts'
import { CORS, akteurVon, darfSchreiben, errMsg, fehler, json, stoppMail } from './gemeinsam.ts'
import { aktionenFreigeben, hochladen, hochladenAusAktionen } from './hochladen.ts'
import { rueckgaengig } from './rueckgaengig.ts'

const REGEL: CallerRule = { cron: true, service: true, roles: ['admin', 'verwalter'], perms: ['werbung'] }
const MODI = ['freigabe', 'fenster', 'validieren', 'rueckgaengig', 'hochladen'] as const
type Modus = typeof MODI[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function aufrufer(req: Request): Promise<Caller | Response> {
  // wie gateCaller: supabase-js schickt bei functions.invoke mit sb_secret nur apikey
  if (safeEqual(req.headers.get('apikey') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return { kind: 'service' }
  return await authorizeCaller(req, REGEL, CORS)
}

function idsAus(v: unknown): string[] {
  return Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(x => UUID.test(x)).slice(0, 200) : []
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  if (req.method !== 'POST') return fehler(405, 'Nur POST')

  const caller = await aufrufer(req)
  if (caller instanceof Response) return caller

  let body: Record<string, unknown>
  try {
    const raw = await req.json()
    body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  } catch {
    return fehler(400, 'Body muss JSON sein')
  }
  const modus = String(body.modus ?? body.mode ?? body.aktion ?? '').trim() as Modus
  if (!MODI.includes(modus)) return fehler(400, `Unbekannter modus "${modus}" (erlaubt: ${MODI.join(', ')})`)
  if (modus !== 'validieren' && !darfSchreiben(caller)) {
    return fehler(403, 'Ausführen dürfen nur Admin oder Nutzer mit dem Recht Werbung')
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const akteur = akteurVon(caller)
  const wer = caller.kind === 'user' ? `Nutzer ${caller.userId.slice(0, 8)}` : caller.kind

  try {
    if (modus === 'hochladen') return await hochladen(sb, caller, body)
    if (modus === 'rueckgaengig') return await rueckgaengig(sb, req, caller, body)

    const gruppeId = String(body.gruppe_id ?? '').trim()
    const ids = idsAus(body.ids)
    if (gruppeId && !UUID.test(gruppeId)) return fehler(400, 'gruppe_id ist ungültig')
    if ((modus === 'freigabe' || modus === 'validieren') && !gruppeId && !ids.length) {
      return fehler(400, `Modus ${modus} braucht gruppe_id oder ids`)
    }

    let erg: AusfuehrenErgebnis
    if (modus === 'fenster') {
      erg = await ausfuehren(sb, { modus: 'fenster', akteur, fn: 'werbe-ausfuehren' })
    } else {
      erg = await ausfuehren(sb, {
        modus: 'freigabe',
        ...(gruppeId ? { gruppeId } : {}),
        ...(ids.length ? { ids } : {}),
        validateOnly: modus === 'validieren',
        akteur,
        fn: 'werbe-ausfuehren',
      })
    }
    // Delegierte Hochlade-Gruppen (ersatz_hochladen) ausführen; nie an die Oberfläche durchreichen
    const delegiert = erg.delegiert ?? []
    delete erg.delegiert
    for (const rows of delegiert) {
      // Validieren lädt nie hoch (kein Lease, kein Bild-Upload; validateOnly hält keinen Claim)
      if (modus === 'validieren') {
        for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: 'nur_bei_ausfuehrung' })
        continue
      }
      if (erg.gestoppt || erg.abgebrochen) {
        await aktionenFreigeben(sb, rows.map(r => r.id))
        for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: erg.gestoppt ? 'autopilot_gestoppt' : `abgebrochen_${erg.abgebrochen}` })
        continue
      }
      // Jede Gruppe für sich: ein Fehler hier hält nie die Claims der anderen Gruppen fest
      try {
        const t = await hochladenAusAktionen(sb, caller, rows)
        erg.ausgefuehrt += t.ausgefuehrt
        erg.fehlgeschlagen += t.fehlgeschlagen
        erg.uebersprungen.push(...t.uebersprungen)
      } catch (err) {
        console.error('[werbe-ausfuehren] Hochlade-Gruppe:', errMsg(err))
        await aktionenFreigeben(sb, rows.map(r => r.id))
        for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: 'interner_fehler' })
      }
    }
    console.log(`[werbe-ausfuehren] ${modus} (${wer}): ausgeführt ${erg.ausgefuehrt}, fehlgeschlagen ${erg.fehlgeschlagen}, übersprungen ${erg.uebersprungen.length}${erg.gestoppt ? ', GESTOPPT' : ''}${erg.abgebrochen ? `, abgebrochen ${erg.abgebrochen}` : ''}`)
    let mail: boolean | undefined
    if (erg.gestoppt) mail = await stoppMail(erg.gestoppt, `werbe-ausfuehren ${modus}${gruppeId ? ` (Gruppe ${gruppeId})` : ''}, ${wer}`)
    return json({ success: true, modus, ...(gruppeId ? { gruppe_id: gruppeId } : {}), ...erg, ...(mail !== undefined ? { stopp_mail: mail } : {}) })
  } catch (err) {
    const msg = errMsg(err)
    console.error(`[werbe-ausfuehren] ${modus}:`, msg)
    return fehler(500, msg.slice(0, 400))
  }
})
