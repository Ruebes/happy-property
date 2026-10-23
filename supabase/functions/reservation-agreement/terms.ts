// Sondervereinbarungen zur Reservierung (Sven 23.10.2026): Sven tippt sie auf Deutsch bei der
// Wohnungsauswahl (deals.reservation_notes), im Vertrag stehen sie auf Englisch. Die Übersetzung
// wird je Ausgangstext in reservation_agreements.special_terms gemerkt, damit Vorschau, Versand
// und Unterschrift denselben Wortlaut haben.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { callAnthropic, textOf } from '../_shared/anthropic.ts'

export interface SpecialTerms { de: string; en: string }

async function translate(de: string): Promise<string | null> {
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 2000,
    label: 'reservation-sondervereinbarung',
    system: 'You translate special agreements for a property reservation agreement in Cyprus from German into clear, formal English as used in Cypriot real-estate contracts. '
      + 'Translate faithfully: do not add, omit, soften or explain anything. Keep amounts, dates, unit numbers and names exactly; write amounts as "EUR 45,000". '
      + 'If the text is already English, return it unchanged except for obvious typos. Output only the translated text, without quotes, headings or comments.',
    messages: [{ role: 'user', content: de }],
  })
  if (!res.ok) { console.error('[reservation-agreement] Übersetzung', res.error); return null }
  const en = textOf(res).trim().replace(/^["„“]+|["“”]+$/g, '').trim()
  return en || null
}

/**
 * Englischer Text für den Vertrag. Leer = keine Sondervereinbarung. problem gesetzt =
 * Übersetzung fehlgeschlagen; dann darf der Vertrag NICHT automatisch raus (sonst fehlte die
 * Vereinbarung still im Vertrag).
 */
export async function specialTermsEn(sb: SupabaseClient, rowId: string, cached: SpecialTerms | null, deText: string | null): Promise<{ en: string; problem: string | null }> {
  const de = (deText ?? '').trim()
  if (!de) return { en: '', problem: null }
  if (cached?.de === de && cached.en) return { en: cached.en, problem: null }
  const en = await translate(de).catch(e => { console.error('[reservation-agreement] Übersetzung', (e as Error).message); return null })
  if (!en) return { en: '', problem: 'Sondervereinbarung konnte nicht ins Englische übersetzt werden, bitte erneut versuchen' }
  const { error } = await sb.from('reservation_agreements').update({ special_terms: { de, en } }).eq('id', rowId)
  if (error) console.warn('[reservation-agreement] special_terms:', error.message)
  return { en, problem: null }
}
