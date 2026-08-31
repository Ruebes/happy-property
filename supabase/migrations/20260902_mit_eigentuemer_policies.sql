-- ═══════════════════════════════════════════════════════════════════════════
-- 20260902_mit_eigentuemer_policies.sql
-- Schritt 2 zu 20260901_mit_eigentuemer.sql: ALLE Eigentümer-Regeln auf die
-- eine Quelle hp_my_property_ids() umstellen, damit eingeladene Mit-Eigentümer
-- (z.B. die Kinder von Rainer Wallmeyer) genau dasselbe sehen und dürfen.
--
-- Vorgabe Sven (31.08.2026): "Wer eingeladen wird, gilt als Eigentümer."
--
-- Stand vor dieser Migration (geprüft am 01.09.2026 gegen die Live-DB):
--   - Tabelle property_co_owners existiert, 0 Zeilen, 9 Wohnungen mit Eigentümer
--   - hp_my_property_ids() und hp_owner_unit_ids() existieren und sind korrekt
--   - 7 Policies sind bereits umgestellt
--   - 19 Policies (public + storage) hängen noch an properties.owner_id
--
-- REIHENFOLGE IST WICHTIG: properties_eigentuemer_select ist die Wurzel. Das
-- Portal lädt zuerst die Wohnungen und reicht deren IDs an alle Folgeabfragen
-- weiter (.in('property_id', propIds)). Steht die Wurzel nicht, bleibt alles
-- leer, auch korrekt umgestellte Tabellen. Deshalb kommt sie zuerst.
--
-- KEINE REKURSION: hp_my_property_ids() ist SECURITY DEFINER und läuft mit den
-- Rechten des Funktions-Eigentümers (postgres). Postgres wendet RLS auf den
-- Tabellen-Eigentümer nicht an (kein FORCE ROW LEVEL SECURITY gesetzt), also
-- laufen die Abfragen im Inneren NICHT erneut durch diese Policies. Genau das
-- ist der Grund, warum property_co_owners_select selbst hp_my_property_ids()
-- benutzen darf, obwohl die Funktion property_co_owners liest.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Helferfunktionen härten ─────────────────────────────────────────────

-- 0a. current_user_role() hat als einzige Helferfunktion KEIN SET search_path.
--     Bei SECURITY DEFINER ist das eine offene Flanke. Body unverändert.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  select role from public.profiles where id = auth.uid();
$function$;

-- 0b. hp_check_co_owner() lief bisher mit den Rechten des Aufrufers und damit
--     durch dessen RLS. Sieht der Aufrufer die properties-Zeile nicht, greift
--     die Dublettenprüfung STILL nicht. Zusätzlich prüfen wir jetzt, dass die
--     eingeladene Person überhaupt ein Eigentümer-Profil ist.
CREATE OR REPLACE FUNCTION public.hp_check_co_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Der Haupteigentümer darf nicht zusätzlich als Mit-Eigentümer drinstehen.
  IF EXISTS (SELECT 1 FROM properties p
              WHERE p.id = NEW.property_id AND p.owner_id = NEW.profile_id) THEN
    RAISE EXCEPTION 'Diese Person ist bereits Eigentümer der Wohnung.';
  END IF;

  -- Nur Portal-Konten dürfen eingeladen werden. Verhindert, dass ein Admin-
  -- oder Mitarbeiter-Konto versehentlich in eine Wohnung gehängt wird.
  IF NOT EXISTS (SELECT 1 FROM profiles pr
                  WHERE pr.id = NEW.profile_id AND pr.role = 'eigentuemer') THEN
    RAISE EXCEPTION 'Nur Konten mit der Rolle eigentuemer können eingeladen werden.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_check_co_owner ON property_co_owners;
CREATE TRIGGER trg_hp_check_co_owner
BEFORE INSERT OR UPDATE ON property_co_owners
FOR EACH ROW EXECUTE FUNCTION hp_check_co_owner();

-- 0c. anon braucht die Helfer nicht (auth.uid() ist dort NULL). Sauber zumachen.
REVOKE EXECUTE ON FUNCTION hp_my_property_ids() FROM anon;
REVOKE EXECUTE ON FUNCTION hp_owner_unit_ids()  FROM anon;
GRANT  EXECUTE ON FUNCTION hp_my_property_ids() TO authenticated;
GRANT  EXECUTE ON FUNCTION hp_owner_unit_ids()  TO authenticated;


-- ═══ 1. DIE WURZEL: properties ═════════════════════════════════════════════
-- Ohne diese Policy sieht der Mit-Eigentümer keine einzige Wohnung und das
-- ganze Portal bleibt leer. Deshalb steht sie ganz vorn.
DROP POLICY IF EXISTS properties_eigentuemer_select ON properties;
CREATE POLICY properties_eigentuemer_select ON properties
  FOR SELECT TO authenticated
  USING (id IN (SELECT hp_my_property_ids())
         AND current_user_role() = 'eigentuemer');


-- ═══ 2. Wohnungsbezogene Tabellen im Schema public ═════════════════════════

-- 2a. Buchungen
DROP POLICY IF EXISTS bookings_eigentuemer_select ON bookings;
CREATE POLICY bookings_eigentuemer_select ON bookings
  FOR SELECT TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND property_id IN (SELECT hp_my_property_ids()));

-- 2b. Verträge
DROP POLICY IF EXISTS contracts_eigentuemer_select ON contracts;
CREATE POLICY contracts_eigentuemer_select ON contracts
  FOR SELECT TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND property_id IN (SELECT hp_my_property_ids()));

-- 2c. Dokumente lesen
DROP POLICY IF EXISTS documents_eigentuemer_select ON documents;
CREATE POLICY documents_eigentuemer_select ON documents
  FOR SELECT TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND property_id IN (SELECT hp_my_property_ids()));

-- 2d. Dokumente hochladen. uploaded_by bleibt an auth.uid() gebunden, damit
--     nachvollziehbar bleibt, WER hochgeladen hat.
DROP POLICY IF EXISTS documents_eigentuemer_write ON documents;
CREATE POLICY documents_eigentuemer_write ON documents
  FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'eigentuemer'
              AND uploaded_by = auth.uid()
              AND property_id IN (SELECT hp_my_property_ids()));

-- 2e. Einnahmen
DROP POLICY IF EXISTS income_eigentuemer_select ON income_entries;
CREATE POLICY income_eigentuemer_select ON income_entries
  FOR SELECT TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND property_id IN (SELECT hp_my_property_ids()));

-- 2f. Eigentümer-Downloads. Bucket owner-docs ist PUBLIC, diese Tabellen-Regel
--     ist die einzige Sperre. Nur der mittlere Zweig wird getauscht.
DROP POLICY IF EXISTS od_read ON owner_documents;
CREATE POLICY od_read ON owner_documents
  FOR SELECT TO authenticated
  USING (property_id IS NULL
         OR property_id IN (SELECT hp_my_property_ids())
         OR EXISTS (SELECT 1 FROM profiles pr
                     WHERE pr.id = auth.uid()
                       AND pr.role = ANY (ARRAY['admin', 'verwalter'])));

-- 2g. Projekte. Bewusst über hp_owner_unit_ids(), damit auch die Teil-Wohnung
--     eines Doppelapartments das Projekt aufschließt.
DROP POLICY IF EXISTS crm_projects_eigentuemer_select ON crm_projects;
CREATE POLICY crm_projects_eigentuemer_select ON crm_projects
  FOR SELECT TO authenticated
  USING (id IN (SELECT u.project_id FROM crm_project_units u
                 WHERE u.id IN (SELECT hp_owner_unit_ids())));

-- 2h. Baustellenfotos (Tabelle). Muss im Doppel mit der Storage-Regel unter 3e
--     umgestellt werden, sonst leere Liste oder Zeilen ohne Bild.
DROP POLICY IF EXISTS construction_photos_eigentuemer_select ON construction_photos;
CREATE POLICY construction_photos_eigentuemer_select ON construction_photos
  FOR SELECT TO authenticated
  USING (current_user_role() = 'eigentuemer'
         AND project_id IN (SELECT u.project_id FROM crm_project_units u
                             WHERE u.id IN (SELECT hp_owner_unit_ids())));

-- 2i. Unterlagen der Einheit hochladen. SELECT und DELETE dieser Tabelle laufen
--     schon über hp_owner_unit_ids(), nur INSERT wurde vergessen. Ohne das
--     sieht der Mit-Eigentümer Unterlagen, kann aber keine hochladen.
DROP POLICY IF EXISTS crm_unit_docs_eigentuemer_insert ON crm_unit_documents;
CREATE POLICY crm_unit_docs_eigentuemer_insert ON crm_unit_documents
  FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid()
              AND unit_id IN (SELECT hp_owner_unit_ids()));


-- ═══ 2j. Zahlungsplan: 6 Policies auf 3 zusammenführen ═════════════════════
-- crm_unit_payments hatte 6 Eigentümer-Policies für 3 Kommandos, teils
-- wortgleich in anderer Schreibweise. Da Policies ODER-verknüpft sind, fällt
-- eine vergessene nicht auf, sie öffnet nur weiter. Ab jetzt: eine pro Kommando.
--
-- Bewusst über hp_my_property_ids() und NICHT hp_owner_unit_ids(): der
-- Zahlungsplan hängt laut 20260901_sub_unit_portal_rls.sql an der GESAMT-
-- einheit, nicht an den Teil-Wohnungen.

DROP POLICY IF EXISTS crm_unit_payments_eigentuemer_select   ON crm_unit_payments;
DROP POLICY IF EXISTS unit_payments_owner_read               ON crm_unit_payments;
DROP POLICY IF EXISTS crm_unit_payments_eigentuemer_insert   ON crm_unit_payments;
DROP POLICY IF EXISTS crm_unit_payments_eigentuemer_update   ON crm_unit_payments;
DROP POLICY IF EXISTS eigentuemer_update_own_payments        ON crm_unit_payments;
DROP POLICY IF EXISTS unit_payments_owner_upload_receipt     ON crm_unit_payments;

CREATE POLICY crm_unit_payments_eigentuemer_select ON crm_unit_payments
  FOR SELECT TO authenticated
  USING (unit_id IN (SELECT id FROM crm_project_units
                      WHERE property_id IN (SELECT hp_my_property_ids())));

CREATE POLICY crm_unit_payments_eigentuemer_insert ON crm_unit_payments
  FOR INSERT TO authenticated
  WITH CHECK (unit_id IN (SELECT id FROM crm_project_units
                           WHERE property_id IN (SELECT hp_my_property_ids())));

-- UPDATE braucht USING UND WITH CHECK. Nur USING umzustellen ließe den
-- Mit-Eigentümer lesen und das Schreiben stumm scheitern (Supabase liefert bei
-- RLS-Block 0 Zeilen OHNE Fehler).
CREATE POLICY crm_unit_payments_eigentuemer_update ON crm_unit_payments
  FOR UPDATE TO authenticated
  USING      (unit_id IN (SELECT id FROM crm_project_units
                           WHERE property_id IN (SELECT hp_my_property_ids())))
  WITH CHECK (unit_id IN (SELECT id FROM crm_project_units
                           WHERE property_id IN (SELECT hp_my_property_ids())));


-- ═══ 3. Storage-Policies ═══════════════════════════════════════════════════
-- Werden diese vergessen, sieht der Mit-Eigentümer die Zeile in der Liste,
-- bekommt aber keine signierte URL. Das wirkt wie ein kaputter Link, nicht wie
-- ein Rechteproblem, und wird deshalb erfahrungsgemäß spät gefunden.
--
-- Pfad-Konventionen (geprüft):
--   documents          = <property_id>/<datei>            -> split_part(name,'/',1)
--   unit-documents     = unit-documents/<unit_id>/<datei> -> split_part(name,'/',2)
--   construction-photos= <project_id>/<datei>             -> split_part(name,'/',1)

-- 3a. Dokumente lesen
DROP POLICY IF EXISTS docs_storage_read ON storage.objects;
CREATE POLICY docs_storage_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents'
         AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
              OR split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text)));

-- 3b. Dokumente hochladen
DROP POLICY IF EXISTS docs_storage_owner_insert ON storage.objects;
CREATE POLICY docs_storage_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents'
              AND current_user_role() = 'eigentuemer'
              AND split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text));

-- 3c. Dokument ersetzen. Hier fehlte bisher das WITH CHECK: ein Update konnte
--     den Objektnamen theoretisch auf eine FREMDE property_id umschreiben.
--     Wird bei der Gelegenheit mit geschlossen.
DROP POLICY IF EXISTS docs_storage_owner_update ON storage.objects;
CREATE POLICY docs_storage_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'documents'
              AND current_user_role() = 'eigentuemer'
              AND split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text))
  WITH CHECK (bucket_id = 'documents'
              AND current_user_role() = 'eigentuemer'
              AND split_part(name, '/', 1) IN (SELECT hp_my_property_ids()::text));

-- 3d. Unterlagen der Einheit hochladen. SELECT und DELETE laufen schon über
--     hp_owner_unit_ids(), INSERT hing zurück und ignorierte zusätzlich die
--     Teil-Wohnungen. Jetzt deckungsgleich mit den Schwesterregeln.
DROP POLICY IF EXISTS unit_docs_eigentuemer_insert ON storage.objects;
CREATE POLICY unit_docs_eigentuemer_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'unit-documents'
              AND split_part(name, '/', 2) IN (SELECT hp_owner_unit_ids()::text));

-- 3e. Baustellenfotos lesen. Erstes Pfad-Segment ist die PROJEKT-ID.
DROP POLICY IF EXISTS construction_photos_bucket_eigentuemer_select ON storage.objects;
CREATE POLICY construction_photos_bucket_eigentuemer_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'construction-photos'
         AND (current_user_role() = ANY (ARRAY['admin', 'verwalter'])
              OR EXISTS (SELECT 1 FROM crm_project_units u
                          WHERE u.project_id::text = split_part(name, '/', 1)
                            AND u.property_id IN (SELECT hp_my_property_ids()))));


-- ═══ 4. Einladen und Entfernen ═════════════════════════════════════════════
-- ENTSCHEIDUNG SVEN: Darf ein Mit-Eigentümer seinerseits weitere Personen
-- einladen? Svens Wortlaut sagt "gleiches sehen und machen dürfen", das
-- hieße ja. Sicherheitstechnisch heißt es: der Kreis wächst als Kette und
-- niemand hat mehr den Überblick, wer Zugriff hat.
--
-- AKTIV ist unten die enge Variante: NUR der eingetragene Haupteigentümer
-- (properties.owner_id) und Sven (admin, über property_co_owners_staff_all)
-- dürfen einladen und entfernen. Das ist bewusst enger als der Rest dieser
-- Migration und der einzige Punkt, an dem Mit-Eigentümer weniger dürfen.
--
-- Sagt Sven "nein, auch Mit-Eigentümer dürfen einladen", dann in beiden
-- Policies unten die EXISTS-Bedingung ersetzen durch:
--     property_id IN (SELECT hp_my_property_ids())
-- und zusätzlich prüfen, dass niemand sich selbst entfernt.

DROP POLICY IF EXISTS property_co_owners_owner_insert ON property_co_owners;
CREATE POLICY property_co_owners_owner_insert ON property_co_owners
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM properties p
                       WHERE p.id = property_co_owners.property_id
                         AND p.owner_id = auth.uid())
              -- invited_by muss der Einladende selbst sein, sonst lässt sich
              -- die Spur, wer wen hereingeholt hat, fälschen.
              AND invited_by = auth.uid());

DROP POLICY IF EXISTS property_co_owners_owner_delete ON property_co_owners;
CREATE POLICY property_co_owners_owner_delete ON property_co_owners
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM properties p
                  WHERE p.id = property_co_owners.property_id
                    AND p.owner_id = auth.uid()));

-- Es gibt bewusst KEINE UPDATE-Policy: eine Zuordnung wird entfernt und neu
-- angelegt, nie umgehängt. Sonst ließe sich per UPDATE die property_id auf
-- eine fremde Wohnung umschreiben.

-- Sven und Verwalter. Bleibt auf current_user_role(), NICHT auf
-- current_user_has_perm('pipeline'): wer Zugänge zu Wohnungen vergibt, soll
-- bewusst Admin sein und nicht über ein Pipeline-Recht mitkommen.
DROP POLICY IF EXISTS property_co_owners_staff_all ON property_co_owners;
CREATE POLICY property_co_owners_staff_all ON property_co_owners
  FOR ALL TO authenticated
  USING      (current_user_role() = ANY (ARRAY['admin', 'verwalter']))
  WITH CHECK (current_user_role() = ANY (ARRAY['admin', 'verwalter']));


-- ═══ 5. BEWUSST NICHT ANGEFASST ════════════════════════════════════════════
-- bank_change_notifications.owner_insert / owner_read_own:
--   Deren owner_id ist eine PROFIL-ID, keine Wohnung. Das ist das Protokoll
--   der IBAN-Änderungen einer PERSON. Ein Mit-Eigentümer darf die Bankdaten-
--   Historie des Haupteigentümers NICHT sehen. Bleibt an auth.uid().
--
-- src/pages/admin/crm/Statistics.tsx nutzt properties.owner_id als
--   Verkaufsindikator. Kein RLS-Bezug, darf nicht ersetzt werden.

COMMIT;


-- ═══ 6. GEGENPROBE nach dem Einspielen (reine SELECTs) ═════════════════════
-- Es darf danach KEINE Zeile mehr geben außer den beiden
-- bank_change_notifications-Regeln:
--
--   SELECT schemaname, tablename, policyname, cmd
--     FROM pg_policies
--    WHERE (coalesce(qual,'')||coalesce(with_check,'')) ILIKE '%owner_id%'
--      AND schemaname IN ('public','storage')
--      AND tablename <> 'bank_change_notifications'
--    ORDER BY 1,2,3;
--
-- Und ein Regressionstest mit einem ECHTEN Haupteigentümer-Login: Dashboard,
-- Objekte, Dokumente, Kalender, Zahlungsplan, Baustellenfotos. Es darf dort
-- nicht MEHR auftauchen als vorher.