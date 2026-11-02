// Öffentliche Supabase-Adresse für alles, was Kunden oder Dritte direkt aufrufen
// (Bilder in Mails und WhatsApp, OAuth-Rückrufe). Die Cloud setzt SUPABASE_URL auf
// https://vjlwgajmtqlwjjreowbu.supabase.co, der eigene Server auf
// https://api.happy-property.com. So bleibt der Code für beide gleich.
// Deno nur optional lesen: verify:deck bündelt _shared-Dateien und läuft unter Node.
const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env
export const SB_URL = (env?.get('SUPABASE_URL') ?? 'https://vjlwgajmtqlwjjreowbu.supabase.co').replace(/\/+$/, '')
