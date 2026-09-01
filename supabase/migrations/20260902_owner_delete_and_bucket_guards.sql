-- ── Eigentümer dürfen löschen, was sie hochgeladen haben ────────────────────
-- Sven (01.09.2026): "Eigentümer sollen Dokumente auch löschen können. Alles,
-- was die hochladen, können sie auch entfernen."
--
-- Bisher gab es weder auf der Tabelle documents noch im Bucket 'documents' eine
-- Löschregel für Eigentümer. Der Klick im Portal lief ins Leere: Supabase
-- meldet bei einer fehlenden Regel keinen Fehler, sondern null Zeilen. Für den
-- Eigentümer sah es aus, als sei gelöscht worden, die Datei blieb liegen.
--
-- Grenze: nur die EIGENEN Uploads. Das eingeladene Familienmitglied kann damit
-- nicht den Kaufvertrag des Haupteigentümers entfernen.

DROP POLICY IF EXISTS documents_eigentuemer_delete ON documents;
CREATE POLICY documents_eigentuemer_delete ON documents
  FOR DELETE TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND uploaded_by = auth.uid()
         AND property_id IN (SELECT hp_my_property_ids()));

-- Storage-Seite. storage.objects führt in der Spalte owner, wer hochgeladen hat.
DROP POLICY IF EXISTS docs_storage_owner_delete ON storage.objects;
CREATE POLICY docs_storage_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents'
         AND current_user_role() = 'eigentuemer'
         AND owner = auth.uid()
         AND split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text));


-- ── Bilder: nur an der eigenen Wohnung ──────────────────────────────────────
-- Sven (01.09.2026): "Eingeloggte Nutzer können nur an ihrer Wohnung Dinge
-- ändern und überschreiben und löschen und hochladen."
--
-- Bisher hingen Upload und Löschen im Bucket 'property-images' NUR an der
-- Bucket-Kennung: jeder angemeldete Nutzer konnte Bilder jeder fremden Wohnung
-- überschreiben oder löschen. Der Pfad ist <property_id>/<datei>, damit lässt
-- sich sauber auf die eigene Wohnung eingrenzen.

DROP POLICY IF EXISTS images_storage_upload ON storage.objects;
CREATE POLICY images_storage_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'property-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text)));

DROP POLICY IF EXISTS images_storage_delete ON storage.objects;
CREATE POLICY images_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'property-images'
         AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
              OR split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text)));

-- Ersetzen (upsert) läuft als UPDATE — dieselbe Grenze, sonst ließe sich ein
-- fremdes Bild überschreiben statt gelöscht zu werden.
DROP POLICY IF EXISTS images_storage_update ON storage.objects;
CREATE POLICY images_storage_update ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'property-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text)))
  WITH CHECK (bucket_id = 'property-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text)));

-- Lesen bleibt öffentlich: die Bild-URLs stecken in Portal und Decks.


-- ── Projektbilder: Sache des Büros, nicht der Kunden ────────────────────────
-- Bucket 'crm-project-images' trägt Projektbilder, WhatsApp-Bilder der Vorlagen
-- und Anhänge aus dem Posteingang. Der Pfad enthält keine Wohnung, eine
-- Eingrenzung auf den Eigentümer ist deshalb gar nicht möglich. Also: schreiben
-- nur Büro (Admin, Verwalter, Mitarbeiter mit Pipeline-Recht). Vorher durfte
-- jeder Angemeldete löschen und überschreiben — auch jeder Eigentümer.

DROP POLICY IF EXISTS crm_images_auth_upload ON storage.objects;
CREATE POLICY crm_images_auth_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-project-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR current_user_has_perm('pipeline')));

DROP POLICY IF EXISTS crm_images_auth_delete ON storage.objects;
CREATE POLICY crm_images_auth_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'crm-project-images'
         AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
              OR current_user_has_perm('pipeline')));

DROP POLICY IF EXISTS crm_images_auth_update ON storage.objects;
CREATE POLICY crm_images_auth_update ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'crm-project-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR current_user_has_perm('pipeline')))
  WITH CHECK (bucket_id = 'crm-project-images'
              AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
                   OR current_user_has_perm('pipeline')));
