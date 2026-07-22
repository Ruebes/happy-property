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

// ── Lotte als Chefin ──────────────────────────────────────────────────────────
// Ein zweiter Bildersatz: Lotte „als Chef", aus dem Google-Drive-Ordner
// „Lotte Boss". Genutzt für Aufgaben-WhatsApps an Mitarbeiter und für Mails an
// Burkhard/Ioulia und Developer-Partner — dort tritt Lotte als Chefin auf, die
// eine Aufgabe vergibt.
//
// Der Ordner ist anfangs LEER. Solange kein Boss-Bild da ist, fällt es auf die
// Office-Bilder zurück (immer noch Lotte, kein nackter Text). Sobald Sven Bilder
// einlegt und den Ordner für den Service-Account freigibt, zieht der Helfer sie
// selbst nach (import_images spiegelt sie öffentlich) und cacht die URLs in
// crm_settings — kein Cron nötig.
//
// deno-lint-ignore no-explicit-any
type Client = any
const BOSS_CACHE_KEY = 'lotte_boss_cache'
const BOSS_FOLDER_KEY = 'lotte_boss_folder_id'
const BOSS_TTL_MS = 7 * 864e5   // höchstens wöchentlich neu aus Drive ziehen

async function loadBossUrls(admin: Client): Promise<string[]> {
  try {
    const { data: cacheRow } = await admin.from('crm_settings').select('value').eq('key', BOSS_CACHE_KEY).maybeSingle()
    const cache = cacheRow?.value ? JSON.parse(cacheRow.value) as { urls?: string[]; at?: number } : null
    const fresh = cache?.at && (Date.now() - cache.at) < BOSS_TTL_MS
    if (fresh && cache?.urls?.length) return cache.urls

    // Neu aus Drive spiegeln (best effort). Ordner leer / nicht freigegeben → [].
    const { data: fRow } = await admin.from('crm_settings').select('value').eq('key', BOSS_FOLDER_KEY).maybeSingle()
    const folderId = (fRow?.value ?? '').trim()
    let urls: string[] = cache?.urls ?? []
    if (folderId) {
      try {
        const { data } = await admin.functions.invoke('google-drive', { body: { action: 'import_images', parent_folder_id: folderId, prefix: 'lotte-boss', limit: 20 } })
        const imgs = (data as { images?: Array<{ url: string }> } | null)?.images ?? []
        if (imgs.length) urls = imgs.map(i => i.url)
      } catch (e) { console.warn('[lotte] Boss-Bilder aus Drive nicht ladbar:', e) }
    }
    // Cache immer aktualisieren (auch leer → verhindert Dauer-Retry pro Nachricht).
    try { await admin.from('crm_settings').upsert({ key: BOSS_CACHE_KEY, value: JSON.stringify({ urls, at: Date.now() }) }, { onConflict: 'key' }) } catch { /* egal */ }
    return urls
  } catch (e) {
    console.warn('[lotte] Boss-Cache-Fehler:', e)
    return []
  }
}

/** Zufälliges „Lotte als Chef"-Bild. Fällt auf die Office-Bilder zurück, solange
 *  der Boss-Ordner leer/ungeteilt ist. */
export async function lotteBossBild(admin: Client): Promise<string> {
  const urls = await loadBossUrls(admin)
  const pool = urls.length ? urls : LOTTE_BILDER
  return pool[Math.floor(Math.random() * pool.length)]
}
