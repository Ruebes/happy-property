import { useEffect, useState } from 'react'

// Trifft die Media-Query gerade zu? Startwert wird synchron gelesen, damit die
// Seitenleiste beim ersten Rendern nicht springt.
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
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
