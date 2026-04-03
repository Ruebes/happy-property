import { supabase } from './supabase'

export type WaEventType = 'no_show' | 'registration' | 'commission' | 'booking'

// ── Sample data for live preview ─────────────────────────────────────────────

export const WA_SAMPLE_DATA: Record<string, string> = {
  lead_name:              'Max Mustermann',
  lead_phone:             '+49 151 12345678',
  lead_email:             'max@mustermann.de',
  lead_whatsapp:          '+49 151 12345678',
  lead_country:           'Deutschland',
  developers:             'Mito, Pafilia',
  registration_notes:     'Bevorzugt Unit A101, Meerblick gewünscht',
  finanzierung_de_notes:  'Finanzierung über Sparkasse, 80% LTV',
  finanzierung_cy_notes:  'Lokale Finanzierung beantragt',
  immobilien_notes:       'Interessiert an Nordturm',
  kaufvertrag_notes:      'Anwalt Dr. Schmidt beauftragt',
  provision_notes:        'Provision per Überweisung erhalten',
  project_name:           'Infinity Residences',
  unit_numbers:      'A101, A102',
  price_net:         '€ 320.000',
  appointment_date:  '15.04.2026 14:00',
  commission_amount: '€ 9.600',
  sales_name:        'Sven Rüprich',
  checkin:           '01.05.2026',
  checkout:          '08.05.2026',
}

// ── All possible placeholder fields ──────────────────────────────────────────

export const WA_FIELDS: { key: string; label_de: string; label_en: string }[] = [
  { key: 'lead_name',         label_de: 'Name des Leads',        label_en: 'Lead name'          },
  { key: 'lead_phone',        label_de: 'Telefon',               label_en: 'Phone'              },
  { key: 'lead_email',        label_de: 'E-Mail',                label_en: 'Email'              },
  { key: 'lead_whatsapp',     label_de: 'WhatsApp',              label_en: 'WhatsApp'           },
  { key: 'lead_country',      label_de: 'Land',                  label_en: 'Country'            },
  { key: 'developers',              label_de: 'Ausgewählte Developer',   label_en: 'Selected Developers'   },
  { key: 'registration_notes',      label_de: 'Notiz: Registrierung',    label_en: 'Note: Registration'    },
  { key: 'finanzierung_de_notes',   label_de: 'Notiz: Finanzierung DE',  label_en: 'Note: Financing DE'    },
  { key: 'finanzierung_cy_notes',   label_de: 'Notiz: Finanzierung CY',  label_en: 'Note: Financing CY'    },
  { key: 'immobilien_notes',        label_de: 'Notiz: Immobilien',       label_en: 'Note: Property'        },
  { key: 'kaufvertrag_notes',       label_de: 'Notiz: Kaufvertrag',      label_en: 'Note: Purchase contract'},
  { key: 'provision_notes',         label_de: 'Notiz: Provision',        label_en: 'Note: Commission'      },
  { key: 'project_name',            label_de: 'Projektname',             label_en: 'Project name'          },
  { key: 'unit_numbers',      label_de: 'Unit Nummern',          label_en: 'Unit numbers'       },
  { key: 'price_net',         label_de: 'Netto-Preis',           label_en: 'Net price'          },
  { key: 'appointment_date',  label_de: 'Termindatum',           label_en: 'Appointment date'   },
  { key: 'commission_amount', label_de: 'Provisionsbetrag',      label_en: 'Commission amount'  },
  { key: 'sales_name',        label_de: 'Verkäufer Name',        label_en: 'Sales person'       },
  { key: 'checkin',           label_de: 'Check-in Datum',        label_en: 'Check-in date'      },
  { key: 'checkout',          label_de: 'Check-out Datum',       label_en: 'Check-out date'     },
]

// ── substituteTemplate ────────────────────────────────────────────────────────

export function substituteTemplate(template: string, data: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(data)) {
    result = result.split(`{{${key}}}`).join(value || '–')
  }
  return result.replace(/\{\{[^}]+\}\}/g, '–')
}

// ── sendWhatsApp ──────────────────────────────────────────────────────────────
// Ruft die Edge Function auf. Fire-and-forget möglich.

export async function sendWhatsApp(params: {
  event_type:     WaEventType
  lead_data:      Record<string, string>   // lead_name, lead_phone, …
  extra_data?:    Record<string, string>   // developers, notes, project_name, …
  lead_id?:       string | null
  override_text?: string                   // für no_show preview (editierter Text)
}): Promise<{ success: boolean; sent?: number; error?: string }> {
  try {
    console.log('[sendWhatsApp] Aufruf:', params.event_type, params.lead_data)

    const { data, error } = await supabase.functions.invoke('send-whatsapp', {
      body: {
        event_type:    params.event_type,
        lead_data:     params.lead_data,
        extra_data:    params.extra_data   ?? {},
        lead_id:       params.lead_id      ?? null,
        override_text: params.override_text ?? null,
      },
    })

    if (error) {
      console.error('[sendWhatsApp] Supabase invoke error:', error)
      throw error
    }

    const result = data as { success: boolean; sent?: number; error?: string; results?: unknown[] }
    console.log('[sendWhatsApp] Ergebnis:', result)

    if (!result.success) {
      console.error('[sendWhatsApp] Edge Function Fehler:', result.error)
    }

    return result
  } catch (err) {
    console.error('[sendWhatsApp] Fehler:', err)
    return { success: false, error: String(err) }
  }
}
