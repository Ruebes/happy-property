import { useEffect, useState } from 'react'

// Trifft die Media-Query gerade zu? Startwert wird synchron gelesen, damit die
// Seitenleiste beim ersten Rendern nicht springt.
// Alles ist abgesichert: Ein Fehler in einem Effekt würde sonst den ganzen
// Rahmen abräumen. Ältere Safari-Versionen (vor 14) kennen an MediaQueryList
// nur addListener / removeListener.
export function useMediaQuery(query: string): boolean {
  const read = () => {
    try { return window.matchMedia(query).matches } catch { return false }
  }
  const [matches, setMatches] = useState<boolean>(read)

  useEffect(() => {
    let mql: MediaQueryList
    try { mql = window.matchMedia(query) } catch { return }
    const onChange = () => setMatches(mql.matches)
    onChange()
    try {
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange)
        return () => { try { mql.removeEventListener('change', onChange) } catch { /* ignorieren */ } }
      }
      mql.addListener(onChange)
      return () => { try { mql.removeListener(onChange) } catch { /* ignorieren */ } }
    } catch {
      // Ohne Änderungs-Meldung bleibt es beim Startwert
      return
    }
  }, [query])

  return matches
}
