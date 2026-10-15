import { supabase } from './supabase'

// Aufrufe der Edge Function reservation-agreement aus dem CRM (nur Admin).

export async function reservationCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('reservation-agreement', { body })
  const d = (data ?? {}) as { error?: string }
  if (error || d.error) {
    // Bei 4xx steckt die Klartext-Meldung im Response-Body, nicht in error.message
    let msg = d.error || error?.message || 'Unbekannter Fehler'
    const ctx = (error as { context?: Response } | null)?.context
    if (ctx && typeof ctx.json === 'function') {
      const j = await ctx.json().catch(() => null) as { error?: string } | null
      if (j?.error) msg = j.error
    }
    throw new Error(msg)
  }
  return data as T
}

/** Fenster SOFORT (synchron im Klick) öffnen, sonst blockt Safari das Popup. */
export function openPdfWindow(): Window | null {
  return window.open('', '_blank')
}

export function showPdf(win: Window | null, base64: string) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  if (win) win.location.href = url
  else window.location.href = url
}
