// Stapel der offenen Überlagerungen aus src/components/ui (Modal, Menü-Popover).
//
// Wozu: useOverlay (src/components/shell) hängt je Overlay einen eigenen
// Tasten-Handler ans Dokument. Liegen zwei übereinander (Bestätigung über einem
// Formular-Dialog, Aktionsmenü in einem Dialog), bekämen ohne diesen Stapel
// BEIDE die Escape-Taste und beide Fokus-Fallen würden sich um den Fokus
// streiten. Mit dem Stapel reagiert immer nur die oberste Ebene.
const layers: string[] = []

export function pushLayer(id: string): void {
  removeLayer(id)
  layers.push(id)
}

export function removeLayer(id: string): void {
  const index = layers.indexOf(id)
  if (index >= 0) layers.splice(index, 1)
}

export function isTopLayer(id: string): boolean {
  return layers.length > 0 && layers[layers.length - 1] === id
}
