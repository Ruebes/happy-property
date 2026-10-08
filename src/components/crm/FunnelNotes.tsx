import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { originFromListName } from '../../lib/crmTypes'

// Lead-Notizen mit lesbarer Herkunft. funnel-api schreibt die UTM-Daten roh als
// „Kanal: {json}" in die Notiz. Die Zeile wird hier nur in der ANZEIGE ersetzt:
// Kanal, bei Newsletter-Buchungen welcher Newsletter den Termin gebracht hat und
// aus welcher Empfängerliste (Webinar, Guide, …) die Adresse ursprünglich kam.

const CHANNEL_LABELS: Record<string, string> = {
  newsletter: 'Newsletter', youtube: 'YouTube', meta: 'META', instagram: 'META', facebook: 'META',
  linkedin: 'LinkedIn', tiktok: 'TikTok', google: 'Google',
}

interface Props { notes: string; email?: string | null; firstName?: string | null }

export default function FunnelNotes({ notes, email, firstName }: Props) {
  const kanalMatch = notes.match(/^Kanal: (\{.*\})$/m)
  let utm: Record<string, string> = {}
  try { utm = kanalMatch ? JSON.parse(kanalMatch[1]) : {} } catch { /* kaputtes JSON: Rohtext bleibt */ }
  const isNewsletter = utm.utm_source === 'newsletter'
  const campaignTag = isNewsletter ? (utm.utm_campaign ?? '').replace(/^nl-/, '') : ''

  const [campaign, setCampaign] = useState<string | null>(null)
  const [origin, setOrigin] = useState<string | null>(null)

  useEffect(() => {
    if (!isNewsletter) return
    let alive = true
    void (async () => {
      if (campaignTag) {
        // Link-Tag ist nl-<erste 8 Zeichen der Kampagnen-ID> (WhatsApp: volle ID)
        const { data } = await supabase.from('newsletter_campaigns').select('id, subject, created_at')
        const c = (data as { id: string; subject: string | null; created_at: string }[] | null)
          ?.find(x => x.id.startsWith(campaignTag))
        if (alive && c) {
          const subj = (c.subject ?? '').replace(/\{\{\s*vorname\s*\}\}/gi, firstName ?? '').replace(/^[,\s]+/, '')
          setCampaign(`„${subj}" (${new Date(c.created_at).toLocaleDateString('de-DE')})`)
        }
      }
      if (email) {
        const { data } = await supabase.from('newsletter_subscribers')
          .select('newsletter_list_members(newsletter_lists(name))')
          .ilike('email', email).limit(1)
        const members = (data as unknown as { newsletter_list_members: { newsletter_lists: { name: string } | null }[] }[] | null)?.[0]?.newsletter_list_members ?? []
        const labels = [...new Set(members.map(m => originFromListName(m.newsletter_lists?.name)).filter((x): x is string => !!x))]
        if (alive && labels.length) setOrigin(labels.join(', '))
      }
    })()
    return () => { alive = false }
  }, [isNewsletter, campaignTag, email, firstName])

  if (!kanalMatch || !utm.utm_source) return <>{notes}</>

  const lines = [`Kanal: ${CHANNEL_LABELS[utm.utm_source] ?? utm.utm_source}`]
  if (isNewsletter) {
    lines.push(`Ursprungsquelle: ${origin ?? '–'}`)
    lines.push(`Newsletter: ${campaign ?? (utm.utm_campaign || '–')}`)
  } else if (utm.utm_campaign) {
    lines.push(`Kampagne: ${utm.utm_campaign}`)
  }
  return <>{notes.replace(kanalMatch[0], lines.join('\n'))}</>
}
