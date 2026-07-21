// Lotte — die Absenderin aller automatischen Kunden-WhatsApps.
//
// Sven: „Ab jetzt stellt sich der Bot immer als Lotte, Svens persönliche
// Assistentin vor. Mit einem Bild meines Hundes. Das sieht niedlich aus, da kann
// der Bot auch mal Scheisse bauen."
//
// Die Bilder werden als persona_image uebergeben, NICHT als file_url: ein
// Deck-Titelbild oder eine Video-Vorschau im Text hat Vorrang (send-whatsapp
// loest das auf). Es gibt nur EINEN Anhang-Slot je Nachricht.
export const LOTTE_BILDER = [
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte1.jpg',
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte2.jpg',
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte3.jpg',
]
export const lotteBild = (): string => LOTTE_BILDER[Math.floor(Math.random() * LOTTE_BILDER.length)]
