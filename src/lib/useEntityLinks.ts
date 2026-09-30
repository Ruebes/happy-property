// React-Seite der Querverweise (die reine Logik steht in entityLinks.ts).
import { useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from './auth'
import { entityPath, type EntityKind, type EntityLinkOpts, type EntityTarget } from './entityLinks'

// entityPath, gebunden an das angemeldete Profil.
export function useEntityPath(): (kind: EntityKind, id: string, opts?: EntityLinkOpts) => EntityTarget | null {
  const { profile } = useAuth()
  return useCallback(
    (kind: EntityKind, id: string, opts?: EntityLinkOpts) => entityPath(kind, id, opts, profile),
    [profile],
  )
}

// Liest einen Deep-Link-Parameter (z.B. ?open=<id>) genau einmal, sobald die
// Seite ihre Daten hat (`ready`), ruft onId und nimmt danach nur den eigenen
// Parameter wieder aus der Adresse (replace, kein neuer Verlaufseintrag).
// Andere Parameter (z.B. ?tab=) bleiben stehen.
export function useDeepLinkParam(name: string, ready: boolean, onId: (id: string) => void): void {
  const [searchParams, setSearchParams] = useSearchParams()
  const handlerRef = useRef(onId)
  useEffect(() => { handlerRef.current = onId }, [onId])
  const doneRef = useRef(false)
  const value = searchParams.get(name)

  useEffect(() => {
    if (!ready || doneRef.current) return
    // Ohne Parameter bleibt der Haken offen: ein späterer Link auf dieselbe
    // Seite (neuer ?open=) wird dann noch bedient.
    if (value === null) return
    doneRef.current = true
    if (value !== '') handlerRef.current(value)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(name)
      return next
    }, { replace: true })
  }, [ready, value, name, setSearchParams])

  // Kommt später ein neuer Wert (Link auf dieselbe Seite), wieder scharf schalten
  useEffect(() => {
    if (value === null) doneRef.current = false
  }, [value])
}
