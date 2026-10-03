import type { TFunction } from 'i18next'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import { STEUERUNG_WRITE_MODES, type SteuerungMode, type SteuerungRequestMap, type SteuerungResponseMap } from '../../../../lib/werbeSteuerung'
import { BuilderFehler, fehlerCode, fehlerText } from '../kampagnen/builderApi'

// ── Aufrufe der Edge Function meta-steuerung (A/B-Tests, Meta-Regeln) ────────
// Typen aus src/lib/werbeSteuerung.ts (gleiche Datei wie im Server). Gleiches
// Fehlerbild wie der Kampagnen-Assistent (BuilderFehler). Lese-Modi und
// Prüfungen (vorschau: true) bekommen bei Netz-Wacklern einen zweiten Versuch,
// Schreib-Modi nie (ob der erste Aufruf bei Meta schon gewirkt hat, ist dann
// unklar). Fehlt die Function noch (nicht deployt), kommt FUNKTION_FEHLT.

const FN = 'meta-steuerung'
export const FUNKTION_FEHLT = 'function_missing'

const NETZ_FEHLER = /Failed to send|Failed to fetch|NetworkError|Load failed/i
const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const istObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function istFunktionFehlt(error: unknown): Promise<boolean> {
  if (!(error instanceof FunctionsHttpError)) return false
  const res = error.context as Response
  if (!res || res.status !== 404) return false
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null
  return !(body && typeof body.error === 'string' && body.error)
}

/** Ein Modus von meta-steuerung. 200-Antworten mit { error } gelten als Fehler. */
export async function steuerungCall<M extends SteuerungMode>(mode: M, req: SteuerungRequestMap[M], retried = false): Promise<SteuerungResponseMap[M]> {
  const { data, error } = await supabase.functions.invoke(FN, { body: { mode, ...req } })
  if (error) {
    const wiederholbar = !STEUERUNG_WRITE_MODES.includes(mode) || (req as { vorschau?: boolean }).vorschau === true
    if (!retried && wiederholbar && NETZ_FEHLER.test(error.message ?? '')) {
      await warte(1500)
      return steuerungCall(mode, req, true)
    }
    if (await istFunktionFehlt(error)) {
      throw new BuilderFehler({ message: 'meta-steuerung ist noch nicht live.', code: FUNKTION_FEHLT })
    }
    throw new BuilderFehler(await fnErrorDetail(error))
  }
  if (istObj(data) && typeof data.error === 'string' && data.error) {
    throw new BuilderFehler({
      message: data.error,
      ...(typeof data.hint === 'string' && data.hint ? { hint: data.hint } : {}),
      ...(typeof data.code === 'string' || typeof data.code === 'number' ? { code: String(data.code) } : {}),
      ...(data.data !== undefined ? { data: data.data } : {}),
    })
  }
  if (!istObj(data)) throw new BuilderFehler({ message: 'Leere Antwort vom Server.' })
  return data as unknown as SteuerungResponseMap[M]
}

/** Verständlicher Fehlertext (fehlende Function, eigene Codes, sonst wie der Assistent) */
export function steuerungFehlerText(e: unknown, t: TFunction): string {
  const code = fehlerCode(e)
  if (code === FUNKTION_FEHLT) {
    return t('crm.werbung.tests.fehler.funktionFehlt', 'Die Server-Funktion für Tests und Regeln ist noch nicht live. Nach dem nächsten Deploy geht es hier weiter.')
  }
  const eigene: Record<string, string> = {
    admin_required: t('crm.werbung.tests.fehler.admin', 'Das darf nur ein Admin (Sven), weil es Ausgaben erhöhen kann.'),
    guardrail: t('crm.werbung.tests.fehler.leitplanke', 'Das würde die Leitplanke des Werbekontos überschreiten.'),
    conflict: t('crm.werbung.tests.fehler.konflikt', 'Das passt nicht zum aktuellen Stand bei Meta.'),
    housing_forbidden: t('crm.werbung.tests.fehler.housing', 'Unter der Sonderkategorie Wohnen nicht erlaubt.'),
    not_found: t('crm.werbung.tests.fehler.nichtGefunden', 'Bei Meta nicht (mehr) gefunden.'),
    unsupported: t('crm.werbung.tests.fehler.unsupported', 'Das unterstützt Meta hier nicht.'),
    invalid_request: t('crm.werbung.tests.fehler.ungueltig', 'Die Angaben passen noch nicht.'),
  }
  if (code && eigene[code] && e instanceof BuilderFehler) {
    const detail = [e.message, e.hint].filter(Boolean).join(' ')
    return detail && detail !== eigene[code] ? `${eigene[code]} ${detail}` : eigene[code]
  }
  return fehlerText(e, t)
}
