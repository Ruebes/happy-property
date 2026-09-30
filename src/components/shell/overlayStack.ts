// Stapel der offenen Überlagerungen: Mehr-Blatt, Suche (über useOverlay),
// Dialoge (src/components/ui/Modal) und Menü-Popover (ActionMenu).
//
// Wozu: jedes Overlay hängt einen eigenen Tasten-Handler ans Dokument. Liegen
// zwei übereinander (Suche über einem Formular-Dialog, Bestätigung über einem
// Dialog, Aktionsmenü in einem Dialog), bekämen ohne diesen Stapel BEIDE die
// Escape-Taste und beide Fokus-Fallen würden sich um den Fokus streiten. Mit
// dem Stapel reagiert immer nur die oberste Ebene.
//
// subscribe/hasOpenLayer: für Bausteine, die sich nach offenen Overlays
// richten (die Hinweise rutschen auf dem Telefon nach oben, solange ein Dialog
// offen ist). Passt zu useSyncExternalStore.
const layers: string[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function pushLayer(id: string): void {
  const index = layers.indexOf(id)
  if (index >= 0) layers.splice(index, 1)
  layers.push(id)
  notify()
}

export function removeLayer(id: string): void {
  const index = layers.indexOf(id)
  if (index < 0) return
  layers.splice(index, 1)
  notify()
}

export function isTopLayer(id: string): boolean {
  return layers.length > 0 && layers[layers.length - 1] === id
}

export function hasOpenLayer(): boolean {
  return layers.length > 0
}

export function subscribeLayers(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
