import {
  CROP_KEY_BY_SLOT, DESTINATION_OPTIONS, MEDIA_ASPECT_RATIOS, adKindsFor, destinationsFor,
  type AdDestination, type AdDestinationKind, type AdDraft, type CropKey, type CtaType, type Destination,
  type KarussellOptionen, type MediaAspect, type Objective, type PreviewFormat,
} from '../../../../lib/metaSpec'

// ── Meta-Parität Runde 2/3: Helfer des Formulars (E Werbemittel, G1 Orte) ────
// Die Typen der neuen Anzeigen-Felder (beitrag, karussell, sprachen,
// partnerschaft, tracking, Ziel-Arten, Medien-Zuschnitt, Vorschaubild) und die
// meta-builder-Modi (posts_list, preview_alle, ad_vorschau_link,
// video_vorschaubilder, video_vorschaubild, video_untertitel) stehen in
// src/lib/metaSpec.ts (be-anzeige). Hier nur, was allein das Formular braucht:
// Conversion-Ort-Karten, Ziel umstellen, HP-Standard-CTA, Zuschnitt je
// Seitenverhältnis, Beschriftungen der Vorschau-Platzierungen.

// ── Medien ───────────────────────────────────────────────────────────────────

/** Seitenverhältnisse der Medien-Slots (metaSpec MediaAspect ohne 'other') */
export type SlotSeiten = Exclude<MediaAspect, 'other'>
/** Metas image_crops-Schlüssel je Seitenverhältnis (metaSpec CROP_KEY_BY_SLOT, nur nach Seitenverhältnis) */
export const CROP_KEY_FUER: Readonly<Record<SlotSeiten, CropKey>> = {
  '4:5': CROP_KEY_BY_SLOT.feed_4x5, '9:16': CROP_KEY_BY_SLOT.story_9x16, '1:1': CROP_KEY_BY_SLOT.square_1x1, '1.91:1': CROP_KEY_BY_SLOT.landscape_191x1,
}
/** Breite durch Höhe je Seitenverhältnis (metaSpec MEDIA_ASPECT_RATIOS) */
export const SEITEN_ZAHL: Readonly<Record<SlotSeiten, number>> = MEDIA_ASPECT_RATIOS

/** Karussell: Seitenverhältnis aller Karten */
export type KarussellSeiten = Extract<SlotSeiten, '1:1' | '4:5'>
/** Bisheriges Karussell-Verhalten des Builders: keine Endkarte, Meta sortiert */
export const karussellVon = (ad: AdDraft): Required<KarussellOptionen> => ({
  endkarte: ad.karussell?.endkarte === true,
  reihenfolge_automatisch: ad.karussell?.reihenfolge_automatisch !== false,
})

// ── Ziel der Anzeige ─────────────────────────────────────────────────────────

/** HP-Standard-Button je Ziel-Art */
export const CTA_STANDARD: Readonly<Record<AdDestinationKind, CtaType>> = {
  website: 'BOOK_NOW', lead_form: 'SIGN_UP', website_lead_form: 'BOOK_NOW',
  whatsapp: 'WHATSAPP_MESSAGE', phone_call: 'CALL_NOW', messenger: 'MESSAGE_PAGE',
}

/** Ziel-Arten, die zum Conversion-Ort passen (metaSpec adKindsFor; erste = Standard) */
export const zielArtenFuer = (destination: Destination | undefined): readonly AdDestinationKind[] => adKindsFor(destination)

/** Ziel auf eine andere Art umstellen; URL, Formular und Telefonnummer bleiben, soweit sie passen */
export function zielUmstellen(alt: AdDestination | undefined, art: AdDestinationKind, standardUrl: string): AdDestination {
  const url = alt && (alt.kind === 'website' || alt.kind === 'website_lead_form') && alt.url ? alt.url : standardUrl
  const display = alt && (alt.kind === 'website' || alt.kind === 'website_lead_form') ? alt.display_link : undefined
  const form = alt && (alt.kind === 'lead_form' || alt.kind === 'website_lead_form') ? alt.form_id : ''
  switch (art) {
    case 'website': return { kind: 'website', url, ...(display ? { display_link: display } : {}) }
    case 'lead_form': return { kind: 'lead_form', form_id: form }
    case 'website_lead_form': return { kind: 'website_lead_form', url, form_id: form, ...(display ? { display_link: display } : {}) }
    case 'whatsapp': return alt && alt.kind === 'whatsapp' ? alt : { kind: 'whatsapp' }
    case 'phone_call': return { kind: 'phone_call', telefon: alt && alt.kind === 'phone_call' ? alt.telefon : '' }
    default: return { kind: 'messenger' }
  }
}

// ── Conversion-Orte der Anzeigengruppe (G1) ──────────────────────────────────

export interface OrtWahl {
  /** destination_type bei Meta */
  wert: string
  titelKey: string
  titel: string
  /** leer = Karte ohne Erklärsatz */
  textKey: string
  text: string
  empfohlen?: boolean
  /** Ersatztext des Sperrgrunds, falls metaSpec keinen reasonKey liefert */
  sperreKey?: string
  sperre?: string
  /** auch bei diesen Kampagnenzielen zeigen (grau mit Grund), obwohl metaSpec den Ort dort nicht anbietet */
  zeigenBei?: readonly Objective[]
}

/** Karten mit eigener Beschreibung (Reihenfolge der Anzeige); welche erscheinen, bestimmt ortWahlenFuer */
export const ORT_WAHLEN: readonly OrtWahl[] = [
  {
    wert: 'WEBSITE', empfohlen: true,
    titelKey: 'crm.werbung.builder.ort.WEBSITE', titel: 'Website',
    textKey: 'crm.werbung.builder.ort.WEBSITE_text', text: 'Termin über die Landingpage oder /termin. Meta optimiert auf das Pixel-Ereignis.',
  },
  {
    wert: 'ON_AD',
    titelKey: 'crm.werbung.builder.ort.ON_AD', titel: 'Sofortformular',
    textKey: 'crm.werbung.builder.ort.ON_AD_text', text: 'Kontaktdaten direkt in Facebook oder Instagram, ohne Seitenwechsel.',
  },
  {
    wert: 'WEBSITE_AND_LEAD_FORM',
    titelKey: 'crm.werbung.builder.ort.WEBSITE_AND_LEAD_FORM', titel: 'Website und Sofortformular',
    textKey: 'crm.werbung.builder.ort.WEBSITE_AND_LEAD_FORM_text', text: 'Meta wählt je Person Landingpage oder Formular, je nachdem, was eher zum Lead führt. Ereignis: Lead.',
  },
  {
    wert: 'WHATSAPP',
    titelKey: 'crm.werbung.builder.ort.WHATSAPP', titel: 'WhatsApp',
    textKey: 'crm.werbung.builder.ort.WHATSAPP_text', text: 'Der Klick öffnet einen WhatsApp-Chat mit Happy Property. Meta optimiert auf Unterhaltungen.',
  },
  {
    wert: 'PHONE_CALL',
    titelKey: 'crm.werbung.builder.ort.PHONE_CALL', titel: 'Anrufe',
    textKey: 'crm.werbung.builder.ort.PHONE_CALL_text', text: 'Der Klick ruft direkt an. Meta optimiert auf Anrufe.',
  },
  {
    // Plan B läuft so (Leads); metaSpec bietet den Ort für neue Anzeigengruppen noch nicht an
    wert: 'WEBSITE_AND_PHONE_CALL', zeigenBei: ['OUTCOME_LEADS'],
    titelKey: 'crm.werbung.builder.ort.WEBSITE_AND_PHONE_CALL', titel: 'Website und Anrufe',
    textKey: 'crm.werbung.builder.ort.WEBSITE_AND_PHONE_CALL_text', text: 'Landingpage plus Anruf-Knopf. So läuft Plan B.',
    sperreKey: 'crm.werbung.builder.ort.sperreWebsiteAnrufe',
    sperre: 'Neue Anzeigengruppen mit Website und Anrufen legt der Assistent noch nicht an. In bestehenden Gruppen (Plan B) gehen neue Website-Anzeigen.',
  },
  {
    wert: 'MESSENGER',
    titelKey: 'crm.werbung.builder.ort.MESSENGER', titel: 'Messenger-Chat',
    textKey: 'crm.werbung.builder.ort.MESSENGER_text', text: 'Der Klick öffnet einen Messenger-Chat mit Happy Property.',
  },
  {
    wert: 'LEAD_FROM_IG_DIRECT',
    titelKey: 'crm.werbung.builder.ort.LEAD_FROM_IG_DIRECT', titel: 'Instagram Direct',
    textKey: 'crm.werbung.builder.ort.LEAD_FROM_IG_DIRECT_text', text: 'Fragen im Instagram-Chat statt im Formular.',
    sperreKey: 'crm.werbung.builder.ort.sperreIgDirect',
    sperre: 'Lead-Anzeigen mit Instagram Direct legt Meta über die Schnittstelle nicht verlässlich an, nur im Werbeanzeigenmanager.',
  },
  {
    wert: 'LEAD_FROM_MESSENGER',
    titelKey: 'crm.werbung.builder.ort.LEAD_FROM_MESSENGER', titel: 'Messenger',
    textKey: 'crm.werbung.builder.ort.LEAD_FROM_MESSENGER_text', text: 'Fragen im Messenger-Chat statt im Formular.',
    sperreKey: 'crm.werbung.builder.ort.sperreMessenger',
    sperre: 'Meta erlaubt Messenger-Lead-Anzeigen seit Version 24 nicht mehr über die Schnittstelle, nur noch im Werbeanzeigenmanager.',
  },
  {
    wert: 'ON_POST',
    titelKey: 'crm.werbung.builder.ort.ON_POST', titel: 'Auf der Anzeige: Beitragsinteraktionen',
    textKey: 'crm.werbung.builder.ort.ON_POST_text', text: 'Meta optimiert auf Reaktionen, Kommentare und geteilte Beiträge direkt an der Anzeige.',
  },
  {
    wert: 'ON_VIDEO',
    titelKey: 'crm.werbung.builder.ort.ON_VIDEO', titel: 'Auf der Anzeige: Videoaufrufe',
    textKey: 'crm.werbung.builder.ort.ON_VIDEO_text', text: 'Meta optimiert darauf, dass das Video angesehen wird.',
  },
  {
    wert: 'UNDEFINED',
    titelKey: 'crm.werbung.builder.ort.UNDEFINED', titel: 'Kein Conversion-Ort',
    textKey: 'crm.werbung.builder.ort.UNDEFINED_text', text: 'Bei Bekanntheit legt Meta keinen Conversion-Ort fest. Die Anzeige verlinkt auf die Website.',
  },
]

/**
 * Karten für ein Kampagnenziel: alle Orte, die metaSpec beim Ziel anbietet (destinationsFor, gesperrte
 * grau mit Grund), dazu Karten mit zeigenBei und der aktuelle Wert (z. B. aus einem Import).
 */
export function ortWahlenFuer(objective: Objective, aktuell: string): OrtWahl[] {
  const angeboten: string[] = destinationsFor(objective)
  const out = ORT_WAHLEN.filter(w => w.wert === aktuell || angeboten.indexOf(w.wert) >= 0 || (w.zeigenBei ?? []).indexOf(objective) >= 0)
  // Orte ohne eigene Karte (z. B. App, Facebook-Seite, Veranstaltung): Metas Bezeichnung, ohne Erklärsatz
  for (const d of angeboten) {
    if (!out.some(w => w.wert === d)) out.push({ wert: d, titelKey: `crm.werbung.meta.destination.${d}`, titel: d, textKey: '', text: '' })
  }
  if (aktuell && !out.some(w => w.wert === aktuell)) {
    out.push({
      wert: aktuell, titelKey: `crm.werbung.meta.destination.${aktuell}`, titel: aktuell,
      textKey: 'crm.werbung.builder.ort.uebernommen', text: 'Aus der bestehenden Anzeigengruppe übernommen.',
    })
  }
  return out
}

export type OrtStatus = { frei: true; wert: Destination } | { frei: false; grundKey: string; grund: string }

/** Ist ein Conversion-Ort beim Kampagnenziel im Assistenten wählbar? (folgt metaSpec, wird automatisch frei) */
export function ortStatus(objective: Objective, w: OrtWahl): OrtStatus {
  const opt = DESTINATION_OPTIONS.find(o => o.value === w.wert)
  if (!opt) {
    return {
      frei: false, grundKey: w.sperreKey ?? 'crm.werbung.builder.ort.sperreFolgt',
      grund: w.sperre ?? 'Folgt: der Weg über die Schnittstelle wird gerade bei Meta geprüft.',
    }
  }
  // Gesperrt laut metaSpec: dessen Grund gilt vor dem Kampagnenziel
  if (opt.unsupported) {
    return {
      frei: false, grundKey: opt.reasonKey ?? w.sperreKey ?? 'crm.werbung.builder.ort.sperreAssistent',
      grund: w.sperre ?? 'Im Assistenten nicht freigeschaltet: der Weg über die Schnittstelle ist noch nicht bestätigt.',
    }
  }
  if ((destinationsFor(objective) as string[]).indexOf(w.wert) < 0) {
    return {
      frei: false, grundKey: 'crm.werbung.builder.ort.sperreZiel',
      grund: 'Passt nicht zum Kampagnenziel.',
    }
  }
  return { frei: true, wert: opt.value }
}

// ── Vorschau aller Platzierungen ─────────────────────────────────────────────

/** Deutsche Ersatz-Beschriftung je Vorschau-Format (den Schlüssel liefert preview_alle als label_key) */
export const PLATZ_LABEL: Readonly<Record<PreviewFormat, string>> = {
  MOBILE_FEED_STANDARD: 'Facebook Feed',
  INSTAGRAM_STANDARD: 'Instagram Feed',
  INSTAGRAM_STORY: 'Instagram Stories',
  INSTAGRAM_REELS: 'Instagram Reels',
  FACEBOOK_REELS_MOBILE: 'Facebook Reels',
  FACEBOOK_STORY_MOBILE: 'Facebook Stories',
  DESKTOP_FEED_STANDARD: 'Facebook Feed (Computer)',
  RIGHT_COLUMN_STANDARD: 'Facebook rechte Spalte',
  MARKETPLACE_MOBILE: 'Facebook Marketplace',
  AUDIENCE_NETWORK_OUTSTREAM_VIDEO: 'Audience Network (Video)',
}
