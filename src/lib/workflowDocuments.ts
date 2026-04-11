// ── Workflow Dokumente Helper ─────────────────────────────────────────────────
// Gibt eine signierte URL für das neueste aktive Dokument einer Kategorie zurück.
// Wird von send-email (Edge Function) und LeadDetail (Vorschau) genutzt.

import { supabase } from './supabase'

export type DocumentCategory =
  | 'finanzierung_de'
  | 'finanzierung_cy'
  | 'willkommen'
  | 'kaufvertrag'
  | 'sonstiges'

export interface WorkflowDocument {
  id:          string
  name:        string
  description: string | null
  category:    DocumentCategory
  file_path:   string
  file_name:   string
  file_size:   number | null
  mime_type:   string | null
  active:      boolean
  created_at:  string
}

// ── Signierte URL für Kategorie ───────────────────────────────────────────────
// Gibt eine 24h-gültige signierte Download-URL für das neueste aktive Dokument
// der angegebenen Kategorie zurück. null wenn kein Dokument vorhanden.

export async function getDocumentForCategory(
  category: string,
  expiresIn = 86400,  // Sekunden: 24h Standard
): Promise<{ url: string; fileName: string } | null> {
  const { data, error } = await supabase
    .from('workflow_documents')
    .select('file_path, file_name')
    .eq('category', category)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  const { data: urlData, error: urlErr } = await supabase.storage
    .from('workflow-documents')
    .createSignedUrl(data.file_path, expiresIn)

  if (urlErr || !urlData?.signedUrl) return null

  return {
    url:      urlData.signedUrl,
    fileName: data.file_name,
  }
}

// ── Vorschau-URL (5 Minuten) ──────────────────────────────────────────────────
export async function getPreviewUrl(filePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('workflow-documents')
    .createSignedUrl(filePath, 300)

  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

// ── Alle Dokumente laden ──────────────────────────────────────────────────────
export async function listWorkflowDocuments(
  category?: DocumentCategory,
): Promise<WorkflowDocument[]> {
  let query = supabase
    .from('workflow_documents')
    .select('*')
    .order('created_at', { ascending: false })

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query
  if (error) {
    console.error('[workflowDocuments] listWorkflowDocuments:', error.message)
    return []
  }
  return (data ?? []) as WorkflowDocument[]
}

// ── Dokument hochladen ────────────────────────────────────────────────────────
export async function uploadDocument(params: {
  file:        File
  name:        string
  description: string
  category:    DocumentCategory
}): Promise<{ success: boolean; error?: string }> {
  const { file, name, description, category } = params
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = `${category}/${Date.now()}_${safeName}`

  const { error: storageErr } = await supabase.storage
    .from('workflow-documents')
    .upload(filePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (storageErr) return { success: false, error: storageErr.message }

  const { error: dbErr } = await supabase
    .from('workflow_documents')
    .insert({
      name:        name.trim(),
      description: description.trim() || null,
      category,
      file_path:   filePath,
      file_name:   file.name,
      file_size:   file.size,
      mime_type:   file.type,
      active:      true,
    })

  if (dbErr) {
    // Storage-Eintrag rückgängig machen
    await supabase.storage.from('workflow-documents').remove([filePath])
    return { success: false, error: dbErr.message }
  }

  return { success: true }
}

// ── Dokument löschen ──────────────────────────────────────────────────────────
export async function deleteDocument(doc: WorkflowDocument): Promise<{ success: boolean; error?: string }> {
  // 1. Storage
  const { error: storageErr } = await supabase.storage
    .from('workflow-documents')
    .remove([doc.file_path])

  if (storageErr) console.warn('[workflowDocuments] Storage delete warn:', storageErr.message)

  // 2. DB (immer ausführen, auch wenn Storage-Löschen fehlschlägt)
  const { error: dbErr } = await supabase
    .from('workflow_documents')
    .delete()
    .eq('id', doc.id)

  if (dbErr) return { success: false, error: dbErr.message }
  return { success: true }
}

// ── Aktiv-Status togglen ──────────────────────────────────────────────────────
export async function toggleDocumentActive(
  id: string,
  active: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('workflow_documents')
    .update({ active })
    .eq('id', id)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Dateigröße formatieren ────────────────────────────────────────────────────
export function formatFileSize(bytes: number | null): string {
  if (!bytes) return '–'
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
