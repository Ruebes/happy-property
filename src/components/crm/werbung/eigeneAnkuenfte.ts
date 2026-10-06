import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import type { AdEigeneAnkuenfte, AdInsightRow } from '../../../lib/crmTypes'

// ── Gegenprobe Zielseite: eigene Besucher je Anzeige ─────────────────────────
// Meta zählt einen Zielseitenaufruf nur, wenn auf der Seite das Meta-Pixel
// feuert. Der eigene Tracker (wa-track, cookie-los) zählt jeden Besuch und
// speichert die UTM-Parameter; die Anzeigen tragen utm_content = {{ad.id}}
// (URL_TAGS_STANDARD in lib/metaSpec.ts). Gezählt werden web_sessions dieser
// Anzeige ohne Bots im selben Tagesfenster wie Metas Zahlen (UTC-Tagesgrenzen,
// das Werbekonto rechnet in seiner eigenen Zeitzone: am Rand ungenau, für eine
// 70-%-Schwelle reicht das).
//
// Nur für die Kandidaten aus lpVerlustKandidaten, je Anzeige eine Zählabfrage
// ohne Zeilen (head), nacheinander (Micro-Instanz). web_sessions lesen nur
// Admins (RLS F10-2). Für alle anderen gibt es 'ohne', weil RLS sonst still 0
// liefert und die 0 wie „niemand angekommen" aussähe.

const tagDanach = (tag: string) => {
  const d = new Date(`${tag}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function useEigeneAnkuenfte(adIds: string[], insights: AdInsightRow[], darfLesen: boolean): AdEigeneAnkuenfte {
  // Tagesfenster je Anzeige aus den geladenen Meta-Zeilen, als Text, damit der
  // Effekt nur bei echter Änderung neu abfragt
  const auftrag = useMemo(() => {
    const ids = new Set(adIds)
    const fenster = new Map<string, { von: string; bis: string }>()
    for (const r of insights) {
      if (!ids.has(r.ad_id)) continue
      const f = fenster.get(r.ad_id)
      if (!f) fenster.set(r.ad_id, { von: r.day, bis: r.day })
      else {
        if (r.day < f.von) f.von = r.day
        if (r.day > f.bis) f.bis = r.day
      }
    }
    return JSON.stringify([...fenster.entries()].sort((x, y) => x[0].localeCompare(y[0])))
  }, [adIds, insights])

  const [stand, setStand] = useState<AdEigeneAnkuenfte>('laedt')

  useEffect(() => {
    if (!darfLesen) { setStand('ohne'); return }
    const liste = JSON.parse(auftrag) as Array<[string, { von: string; bis: string }]>
    if (!liste.length) { setStand(new Map()); return }
    let abgebrochen = false
    setStand('laedt')
    void (async () => {
      const je = new Map<string, number>()
      try {
        for (const [adId, f] of liste) {
          const { count, error } = await supabase.from('web_sessions')
            .select('id', { count: 'exact', head: true })
            .eq('is_bot', false)
            .eq('utm->>utm_content', adId)
            .gte('started_at', `${f.von}T00:00:00Z`)
            .lt('started_at', `${tagDanach(f.bis)}T00:00:00Z`)
          if (error) throw error
          je.set(adId, count ?? 0)
        }
        if (!abgebrochen) setStand(je)
      } catch (err) {
        console.warn('[AdsManager] eigene Besucherzahlen nicht ladbar:', err)
        if (!abgebrochen) setStand('ohne')
      }
    })()
    return () => { abgebrochen = true }
  }, [auftrag, darfLesen])

  return stand
}
