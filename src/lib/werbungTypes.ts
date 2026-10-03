// ── Werbung: Autopilot, Qualität, Vorrat ─────────────────────────────────────
// Zeilentypen für ad_settings-Autopilot-Felder, ad_quality_daily,
// ad_autopilot_rules/-log/-runs und ad_creative_pool. Wird über crmTypes.ts
// re-exportiert (export * from './werbungTypes'). Platzhalter: der
// Autopilot-Baustein füllt diese Datei.

/** Betriebsart des Autopiloten (ad_settings.autopilot_mode), aufsteigend */
export type WerbeAutopilotModus = 'aus' | 'schatten' | 'vorschlag' | 'ein_klick' | 'autonom'
