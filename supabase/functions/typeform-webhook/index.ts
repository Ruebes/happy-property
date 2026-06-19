// Supabase Edge Function: typeform-webhook
// Endpunkt für Typeform Webhooks.
// In Typeform eintragen unter: Connect → Webhooks → Endpoint URL = <supabase-url>/functions/v1/typeform-webhook

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const payload = await req.json()

    // Hidden Fields (UTM-Parameter, Werbekanal etc.)
    // Typeform sendet diese unter form_response.hidden
    const hidden = (payload.form_response?.hidden ?? {}) as Record<string, string>

    // Typeform sendet answers Array + definition.fields
    const answers = (payload.form_response?.answers ?? []) as Array<{
      field: { id: string }
      type: string
      text?: string
      email?: string
      phone_number?: string
      number?: number
      choice?: { label: string }
      choices?: { labels: string[] }
    }>
    const fields = (payload.form_response?.definition?.fields ?? []) as Array<{
      id: string
      title: string
    }>

    // Antwort nach Field-Titel-Keyword finden
    function getAnswer(keyword: string): string | null {
      const field = fields.find(f => f.title.toLowerCase().includes(keyword.toLowerCase()))
      if (!field) return null
      const answer = answers.find(a => a.field.id === field.id)
      if (!answer) return null
      switch (answer.type) {
        case 'text':         return answer.text ?? null
        case 'email':        return answer.email ?? null
        case 'phone_number': return answer.phone_number ?? null
        case 'number':       return answer.number != null ? String(answer.number) : null
        case 'choice':       return answer.choice?.label ?? null
        case 'choices':      return answer.choices?.labels?.join(', ') ?? null
        default:             return null
      }
    }

    // Lead-Daten aus Typeform-Feldern extrahieren
    const rawName   = getAnswer('name') ?? ''
    const firstName = getAnswer('vorname') ?? getAnswer('first name') ?? rawName.split(' ')[0] ?? ''
    const lastName  = getAnswer('nachname') ?? getAnswer('last name') ?? rawName.split(' ').slice(1).join(' ') ?? ''
    const email     = getAnswer('email') ?? getAnswer('e-mail') ?? ''

    // Telefon: erst per Keyword suchen, dann Fallback auf erstes phone_number-Feld
    // (unabhängig vom Feldtitel – fängt alle Typeform-Feldnamen ab)
    const phoneByKeyword =
      getAnswer('telefon') ??
      getAnswer('phone')   ??
      getAnswer('handy')   ??
      getAnswer('mobil')   ??
      getAnswer('mobile')  ??
      getAnswer('nummer')  ??
      getAnswer('tel')     ??
      getAnswer('whatsapp')
    const phoneByType = answers.find(a => a.type === 'phone_number')?.phone_number ?? null
    const phone = phoneByKeyword ?? phoneByType ?? null
    const country   = getAnswer('land') ?? getAnswer('country') ?? null
    const notes     = getAnswer('nachricht') ?? getAnswer('message') ?? getAnswer('bemerkung') ?? null
    // Source: erst Hidden Fields (UTM/Ads), dann Formular-Antwort
    // Typeform Hidden Fields kommen z.B. als ?utm_source=meta in der Formular-URL
    const utmSource  = hidden['utm_source'] ?? hidden['source'] ?? hidden['kanal'] ?? null
    const utmMedium  = hidden['utm_medium'] ?? null
    const utmCampaign = hidden['utm_campaign'] ?? null
    const utmContent = hidden['utm_content'] ?? null

    // Source-Mapping: utm_source → CRM-Quelle (muss mit leads_source_check übereinstimmen)
    function mapSource(raw: string | null): 'meta' | 'google' | 'empfehlung' | 'sonstiges' | null {
      if (!raw) return null
      const s = raw.toLowerCase()
      if (s.includes('meta') || s.includes('facebook') || s.includes('instagram')) return 'meta'
      if (s.includes('google'))                                                      return 'google'
      if (s.includes('empfehlung') || s.includes('referral') || s.includes('ref'))  return 'empfehlung'
      return 'sonstiges'
    }

    const sourceFromHidden = mapSource(utmSource)
    // WICHTIG: Formular-Antwort ebenfalls durch mapSource() — sonst landet ein
    // Roh-Label (z.B. „Instagram") in leads.source und verletzt den DB-Constraint
    // leads_source_check → Insert crasht → Lead geht verloren.
    const sourceFromForm   = mapSource(getAnswer('quelle') ?? getAnswer('source') ?? null)
    const source = sourceFromHidden ?? sourceFromForm

    if (!email && !firstName) {
      return new Response(
        JSON.stringify({ error: 'Kein Name oder E-Mail im Payload gefunden.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Prüfen ob Lead mit dieser E-Mail bereits existiert
    let leadId: string
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    if (existing) {
      leadId = existing.id
      console.log('[typeform-webhook] Bestehender Lead gefunden:', leadId)
    } else {
      const { data: newLead, error } = await supabase
        .from('leads')
        .insert({
          first_name:    firstName,
          last_name:     lastName,
          email:         email || null,
          phone:         phone,
          country:       country,
          source:        source ?? 'sonstiges',
          status:        'new',
          language:      'de',
          utm_source:    utmSource,
          utm_medium:    utmMedium,
          utm_campaign:  utmCampaign,
          utm_content:   utmContent,
        })
        .select('id')
        .single()

      if (error || !newLead) {
        throw new Error(`Lead-Erstellung fehlgeschlagen: ${String(error?.message)}`)
      }
      leadId = newLead.id
      console.log('[typeform-webhook] Neuer Lead angelegt:', leadId)
    }

    // Deal in Phase "erstkontakt" anlegen (nur wenn noch keiner existiert)
    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('lead_id', leadId)
      .maybeSingle()

    let dealId: string | null = existingDeal?.id ?? null

    if (!existingDeal) {
      const { data: newDeal } = await supabase
        .from('deals')
        .insert({
          lead_id: leadId,
          phase:   'erstkontakt',
        })
        .select('id')
        .single()
      dealId = newDeal?.id ?? null
    }

    // Aktivität loggen
    await supabase.from('activities').insert({
      lead_id:      leadId,
      deal_id:      dealId,
      type:         'note',
      direction:    'inbound',
      subject:      'Typeform ausgefüllt',
      content:      notes ?? 'Lead über Typeform eingegangen',
      completed_at: new Date().toISOString(),
    })

    console.log('[typeform-webhook] Erfolg:', { leadId, dealId })

    return new Response(
      JSON.stringify({ success: true, lead_id: leadId, deal_id: dealId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[typeform-webhook] Fehler:', err)
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
