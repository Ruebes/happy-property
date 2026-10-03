import { useCallback, useEffect, useRef, useState } from 'react'
import { nacheinander } from './messungApi'

// ── Laden einer Karte, eingereiht hinter alle anderen ────────────────────────
// Jede Karte lädt erst, wenn `aktiv` true ist (Seitendaten fertig), und über
// nacheinander(): die Karten des Reiters fragen Datenbank und Meta nie parallel.
// Fehler bleiben als Rohwert erhalten (die Karte macht daraus den Text).

export interface Lader<T> {
  daten: T | null
  laedt: boolean
  fehler: unknown
  neu: () => Promise<void>
  setDaten: (d: T | null) => void
}

export function useLader<T>(laden: () => Promise<T>, aktiv: boolean): Lader<T> {
  const [daten, setDaten] = useState<T | null>(null)
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)
  const lebt = useRef(true)
  const fn = useRef(laden)
  fn.current = laden

  useEffect(() => {
    lebt.current = true
    return () => { lebt.current = false }
  }, [])

  const neu = useCallback(async () => {
    setLaedt(true)
    try {
      const d = await nacheinander(() => fn.current())
      if (!lebt.current) return
      setDaten(d)
      setFehler(null)
    } catch (err) {
      if (!lebt.current) return
      console.warn('[Messung] Laden:', err)
      setFehler(err)
    } finally {
      if (lebt.current) setLaedt(false)
    }
  }, [])

  const gestartet = useRef(false)
  useEffect(() => {
    if (!aktiv || gestartet.current) return
    gestartet.current = true
    void neu()
  }, [aktiv, neu])

  return { daten, laedt, fehler, neu, setDaten }
}
