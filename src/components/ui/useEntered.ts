import { useEffect, useState } from 'react'

// 'before': erstes Rendern, Ausgangszustand der Einblendung
// 'entering': Zielzustand, die CSS-Transition läuft
// 'done': Zielzustand ohne Transition
export type EnterPhase = 'before' | 'entering' | 'done'

// Ersatz-Auslöser, falls der Browser keinen Frame liefert
const ENTER_FALLBACK_MS = 60
// Dauer der Einblendung (duration-200) plus Reserve
const SETTLE_MS = 320

// Phasen einer Einblend-Animation (Klassenwechsel nach dem ersten Zeichnen).
//
// requestAnimationFrame allein reicht nicht: In gedrosselten oder verdeckten
// Tabs kommt kein Frame, das Element bliebe unsichtbar. Der Timer zieht den
// Wechsel spätestens nach ENTER_FALLBACK_MS nach.
// Auch die Transition selbst braucht Frames: Bleiben sie mittendrin aus, hinge
// das Element halb durchsichtig fest. Darum gibt es 'done': nach SETTLE_MS
// nimmt der Aufrufer die Transition weg (transition-none), der Zielzustand gilt
// dann sofort und unabhängig von der Animations-Uhr.
export function useEnterPhase(): EnterPhase {
  const [phase, setPhase] = useState<EnterPhase>('before')
  useEffect(() => {
    const enter = () => setPhase(prev => (prev === 'before' ? 'entering' : prev))
    const frame = requestAnimationFrame(enter)
    const timer = window.setTimeout(enter, ENTER_FALLBACK_MS)
    const settle = window.setTimeout(() => setPhase('done'), SETTLE_MS)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      window.clearTimeout(settle)
    }
  }, [])
  return phase
}
