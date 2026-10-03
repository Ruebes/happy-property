// ── Ansichts-Typen für den Reiter „Messung & Konto" ──────────────────────────
// Datensatz, CRM-Ereignisse, Stufen und eigene Conversions nutzen die Typen aus
// src/lib/werbeWerkzeuge.ts (meta-werkzeuge), Konto und Kommentare die aus
// src/lib/werbeKonto.ts (meta-konto). Hier stehen nur die Typen, die das
// Frontend selbst braucht.

export type Ampel = 'gruen' | 'gelb' | 'rot' | 'grau'

// ── CRM-Ereignisse (capi_outbox, nur Ersatz-Weg) ─────────────────────────────
// Normal liefert pixel_diagnose die Zahlen (crm: PixelDiagnoseCrm, inkl. capi_log
// und Tageslauf). Nur wenn die deployte Function das Feld noch nicht kennt,
// zählt der Reiter den Ausgang selbst.

export interface OutboxZeile {
  event_id: string
  event_name: string
  status: string
  grund: string | null
  created_at: string
  gesendet_at: string | null
}

export interface CrmEreignisseErgebnis {
  /** false = Tabelle capi_outbox fehlt noch (Migration nicht eingespielt) */
  verfuegbar: boolean
  zeilen: OutboxZeile[]
  /** Liste wurde beim Limit abgeschnitten */
  gekappt: boolean
}

/** ad_settings-Felder, die der Reiter braucht (fehlende Spalten = null) */
export interface MessEinstellungen {
  builderEnabled: boolean | null
  capiEchtzeit: boolean | null
}
