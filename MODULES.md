# Modul-Landkarte (Stand: 18.08.2026)

Zweck: Das CRM soll an andere Immobilienunternehmen (zunächst deutsche Makler)
verkauft werden. Diese Datei ist die verbindliche Landkarte, welcher Code zu
welchem verkaufbaren Modul gehört.

**Grundregel: Es gibt genau eine Codebasis. Module sind Schalter, keine Kopien.**
Kein Fork, kein Kundenzweig, kein Copy-Paste in ein zweites Repo. Ein Bug, der im
Happy-Property-System gefunden wird, wird in genau einer Datei gefixt und ist
damit für alle Kunden gefixt. Sobald Code dupliziert wird, driften die Stände
auseinander und jeder Bug muss mehrfach gefixt werden.

---

## Basis (kein Modul, jeder Kunde bekommt sie)

Ohne diesen Teil läuft nichts. Wird nicht separat verkauft.

- Seiten: `Login`, `SetPassword`, `Anmelden`, `Abmelden`, `admin/crm/CrmDashboard`,
  `Pipeline`, `AllLeads`, `LeadDetail`, `Archived`, `Tasks`, `Calendar`,
  `Postausgang`, `Statistics`, `StaffHome`, `admin/Users`,
  `Settings` inkl. `settings/StageMessages`, `settings/AutomationRules`,
  `settings/AdhocMessages`, `settings/WhatsappTemplates`, `settings/AiAgent`,
  `settings/Connectors`, `settings/Documents`, `settings/Contacts`
- Komponenten: `DashboardLayout`, `ProtectedRoute`, `AppointmentModal`,
  `AppointmentPrepPopup`, `TaskNotifications`, `RecipientPicker`, `LeadQuickSend`,
  `GoogleEventModal`, `CustomSelect`, `NumberStepper`, `LanguageSwitcher`
- Edge Functions: `send-email`, `send-whatsapp`, `schedule-message`,
  `process-scheduled-messages`, `task-notify`, `task-action`, `tasks-maintenance`,
  `recurring-followups`, `google-calendar`, `admin-user-ops`, `crm-webhook-sender`,
  `track-engagement`, `timelines-webhook`, `simulate-automations`, `connectors`,
  `place-search`, `cal`, `nightly-health`
- Tabellen: `profiles`, `leads`, `deals`, `activities`, `activity_log`, `crm_tasks`,
  `crm_task_assignees`, `crm_task_leads`, `crm_task_messages`, `crm_appointments`,
  `messages`, `scheduled_messages`, `crm_adhoc_messages`, `whatsapp_templates`,
  `email_templates`, `automation_rules`, `crm_settings`, `crm_business_contacts`,
  `crm_lead_sources`, `wa_sent`, `wa_processed`, `communication_optouts`,
  `short_links`, `integration_secrets`, `crm_webhooks`, `webhook_debug`,
  `lead_ai_summaries`

---

## M1 Projekte und Angebots-Decks

Projektverwaltung, Wohnungsbestand, Preislisten-Import und der KI-Deck-Generator.
Zusammengelegt, weil Decks ohne Projekt- und Wohnungsdaten nicht funktionieren.
Stärkstes Alleinstellungsmerkmal, teuerstes Modul.

- Seiten: `Projects`, `ProjectDetail`, `Deck` (`/deck/:token`, `/deck/:token/print`)
- Komponenten: `DeckWizard`, `DeckChat`, `UnitPickerModal`, `UnitImagesUploader`,
  `ProjectSelectionModal`, `ConstructionPhotos`, `DeveloperContactsModal`,
  `LeadAngebote`
- Edge Functions: `generate-deck`, `refine-deck`, `compose-deck-mail`,
  `parse-pricelist`, `parse-spec-xlsx`, `scan-drive-projects`,
  `prepare-project-assets`, `extract-project-facts`, `resolve-maps-link`,
  `google-drive`, `construction-media`, `create-client-drive-folder`
- Tabellen: `crm_projects`, `crm_project_units`, `crm_unit_documents`,
  `crm_unit_payments`, `crm_developers`, `crm_developer_contacts`, `deal_projects`,
  `sales_decks`, `deck_outbox`, `deck_ai_rules`, `construction_photos`
- Abhängigkeit: Basis
- Anpassungsbedarf: Deck-Layout und Textbausteine sind auf Happy-Property-Stil
  gebaut, Bauträger-Importer (Luma, Kuutio) sind kundenspezifisch.

## M2 Rendite-Rechner und Strategie-Simulator

- Seiten: `Rechnung` (`/rechnung/:token`), `Strategie` (`/strategie/:token`)
- Komponenten: `RechnerWizard`, `StrategySimulator`
- Bibliothek: `src/lib/rechner.ts`, `src/lib/calcOutbox.ts`
- Tabellen: `property_calculations`, `crm_strategy_scenarios`
- Abhängigkeit: Basis, optional M1 (Preise direkt aus Wohnungen ziehen)
- OFFEN vor Verkauf: Die Berechnung ist auf Zypern zugeschnitten (MwSt-Sätze,
  DBA-Anrechnung, Kurzzeit- gegen Langzeitvermietung). Für deutsche Makler muss
  der zyprische Teil raus und durch deutsche Logik ersetzt werden (AfA,
  Grunderwerbsteuer je Bundesland, Notar/Grundbuch, Mietrecht). Bis dahin nicht
  verkaufbar.

## M3 Terminfunnel und Buchung

- Seiten: `Funnel` (`/termin`), `FunnelEditor`, `FunnelStats`,
  `BookingPage` (`/buchen/:slug`), `TerminVerwalten`, `settings/BookingLinks`
- Komponenten: `BookingModal`
- Edge Functions: `funnel-api`, `personal-booking`, `booking-bot`,
  `send-booking-confirmation`, `create-zoom-meeting`, `personalize-invite`
- Tabellen: `funnel_config`, `funnel_sessions`, `funnel_events`,
  `booking_conversations`, `booking_bot_messages`
- Abhängigkeit: Basis
- Altlasten, die beim Verkauf raus können: `calendly-webhook`, `calendly-status`,
  `sync-calendly`, `typeform-webhook`

## M4 Werbemanager

- Seiten: `AdsManager`
- Komponenten: `AdStudio`, `TargetingEditor`
- Edge Functions: `meta-ads-sync`, `meta-ads-tools`, `ad-studio`, `studio`
- Abhängigkeit: Basis. Ohne M3 fehlt die Quellenzuordnung am Lead, dann sind die
  Kennzahlen nur halb aussagekräftig.
- Hinweis: Braucht pro Kunde eigenen Meta-System-User-Token und eigene App-Freigabe.

## M5 Newsletter und Flows

- Seiten: `Newsletter`, `settings/NewsletterLists`, `Workflows`
- Komponenten: `FlowBuilder`, `SequenceEditor`, `SubscribersModal`
- Edge Functions: `newsletter-campaign`, `klaviyo-sync`, `subscriber-optin`,
  `run-workflows`, `learn-mail`
- Tabellen: `newsletter_campaigns`, `newsletter_lists`, `newsletter_list_members`,
  `newsletter_subscribers`, `funnel_workflows`, `funnel_workflow_runs`,
  `workflow_documents`
- Abhängigkeit: Basis. Split-Verzweigungen der Flows lesen Engagement-Ereignisse,
  die aus M1 (Deck angesehen) und M2 (Rechnung angesehen) kommen. Ohne die Module
  funktionieren nur zeit- und listenbasierte Flows.

## M6 Social Studio

- Seiten: `SocialStudio`, `ThumbnailStudio`
- Edge Functions: `social-agent`, `youtube-latest`, `yt-oauth`
- Abhängigkeit: Basis
- Hinweis: Braucht eigenes Higgsfield- beziehungsweise OpenAI-Guthaben pro Kunde.

## M7 Posteingang

- Seiten: `Inbox`
- Edge Functions: `imap-poll`, `ai-draft-reply`
- Tabellen: `messages` (Mail-Anteil), `ai_reply_examples`
- Abhängigkeit: Basis

## M8 Rechnungen und Buchhaltung

- Seiten: `Invoices`, `settings/InvoiceSettings`, `Invoice` (`/re/:token`), `Finance`
- Komponenten: `DepositInvoiceModal`
- Edge Functions: `generate-invoice`, `analyze-invoice`, `revolut-sync`,
  `notify-bank-change`
- Tabellen: `crm_invoices`, `crm_invoice_items`, `invoice_articles`,
  `invoice_customers`, `invoice_settings`, `income_entries`,
  `bank_change_notifications`, `fin_*`
- Abhängigkeit: Basis
- Anpassungsbedarf: Rechnungssteller sveru ltd und zyprische Steuersätze sind fest
  hinterlegt, müssen konfigurierbar werden (deutsche Umsatzsteuer, Kleinunternehmer).

## M9 Eigentümerportal

- Seiten: `eigentuemer/*`, `Objekte`, `Dokumente`, `Kalender`, `Dashboard`,
  `PropertyDetail`, `Sign` (`/sign/:token`), `Zusage`, `OwnerContent`
- Komponenten: `GrantAccessModal`, `RegistrationModal`, `LeadRegistrations`,
  `MailAttachments`, `DevMails`
- Edge Functions: `create-eigentuemer-access`, `owner-content`,
  `construction-update`
- Tabellen: `properties`, `documents`, `contracts`, `portal_logins`,
  `lead_registrations`
- Abhängigkeit: Basis und M1

## M10 Kaltakquise

Eigenes Repository (`~/Downloads/lead-acquisition-pipeline` und
`~/Downloads/acquisition-app`), eigenes Produkt. Kann komplett allein verkauft
werden, teilt sich mit dem CRM nur die Lead-Übergabe.

---

## Nicht Teil des Verkaufsprodukts

Bleibt im Happy-Property-System, wird nicht als Modul angeboten:

- Ferienvermietung: `feriengast/*`, `verwalter/*`, `verwaltung/*`, `BookingModal`
  für Gäste, Tabellen `bookings`, `guest_agreements`, `subscription_plans`
- Partner-Review und Partner-Akte: `PartnerReview`, `PartnerAkte`,
  `partner-review`, `partner-review-remind`, `partner-akte`, `PartnerShareModal`
- Happy-Property-spezifisch: Lotte-Persona, DBA-Zypern-Inhalte, Luma- und
  Kuutio-Importer

---

## Betriebsmodell: eine Instanz pro Kunde (entschieden 18.08.2026)

Jeder Kunde bekommt ein eigenes Supabase-Projekt und ein eigenes
Vercel-Deployment. Alle Instanzen laufen auf demselben Git-Stand. Kein
kundeneigener Branch, kein zweites Repository.

### Was "an seine Bedürfnisse angepasst" bedeuten darf

Das ist der kritische Punkt. Anpassung pro Kunde ist erlaubt, aber nur über
Konfiguration, nicht über Code. Sonst ist die Anforderung "Bugfix bei mir landet
bei allen" sofort tot.

**Erlaubt (Konfiguration, liegt in der Kundendatenbank oder in Umgebungsvariablen):**

- Branding: Name, Logo, Farben, Domain, Absenderadresse, Signatur
- KI-Persona: Name, Bild, Tonfall (bei uns Lotte, beim Kunden etwas anderes)
- Pipeline-Stufen, Aufgabenarten, Textbausteine, Mail- und WhatsApp-Vorlagen
- Rechnungsdaten: Aussteller, Steuernummer, Bank, Steuersätze, Nummernkreis
- Rechner-Regelwerk: Land, Steuerlogik, Nebenkostensätze
- Deck-Gestaltung: Farbschema, Schrift, Reihenfolge der Seiten
- Modulschalter: welche Module gekauft sind
- Integrationen: eigene Zugangsdaten für Meta, Google, WhatsApp, Mail, Bank

**Nicht erlaubt:**

- Dateien in einer Kundeninstanz ändern
- Kundeneigener Branch oder Fork
- "Nur für Kunde X" Sonderlogik ohne Schalter im gemeinsamen Code

**Wenn ein Kunde etwas will, das die Konfiguration nicht abdeckt:** Es wird als
Funktion im gemeinsamen Code gebaut, hinter einem Schalter, standardmäßig aus.
Andere Kunden bekommen sie damit automatisch mit, ohne dass sich bei ihnen etwas
ändert.

### Was heute im Weg steht

Der Code ist noch nicht konfigurierbar, sondern fest auf Happy Property
verdrahtet. Gezählte Vorkommen:

| Begriff | in `src` | in Edge Functions |
|---|---|---|
| happy-property / happyproperty | 48 | 92 |
| Lotte | 39 | 314 |
| Zypern / Cyprus | 53 | 125 |
| sveru | 4 | 18 |

Betroffen sind rund 40 Frontend-Dateien und 45 der 66 Edge Functions. Das ist der
eigentliche Aufwand vor dem ersten Verkauf, nicht die Modulaufteilung.

Reihenfolge der Arbeit:

1. Zentrale Mandantenkonfiguration einführen (eine Tabelle plus ein
   `src/lib/tenant.ts` und ein Gegenstück in `supabase/functions/_shared/`)
2. Branding, Absender und Persona aus dem Code in diese Konfiguration ziehen
3. Modul-Registry `src/lib/modules.ts` plus Filterung von Navigation und Routen
4. Rechner auf Länderregelwerk umbauen, zyprischer Teil wird ein Regelwerk unter
   vielen (siehe M2)
5. Ausroll-Skript unter `scripts/`, das alle Instanzen deployt und migriert

---

## Wie Bugfixes in allen Modulen landen

1. **Eine Codebasis, keine Forks.** Jeder Kunde läuft auf demselben Git-Stand.
   Ein Modul ist ein Schalter, kein eigenes Repository.
2. **Mandantentrennung über eigene Instanz.** Pro Kunde eigenes Supabase-Projekt
   und eigenes Vercel-Deployment, gleicher Code. Das ist deutlich schneller
   umsetzbar als echte Mehrmandantenfähigkeit im Datenmodell.
3. **Modulschalter getrennt vom Rechtesystem.** Die bestehenden `permissions`
   regeln, wer etwas darf. Die Modulschalter regeln, was gekauft wurde. Beides
   muss unabhängig bleiben, sonst kann man Mitarbeiterrechte nicht mehr sauber
   vergeben.
4. **Registry statt Dokumentation.** Diese Datei beschreibt die Aufteilung, aber
   die Zuordnung Modul zu Route und Navigation gehört zusätzlich in eine
   maschinenlesbare Registry (`src/lib/modules.ts`), die die App tatsächlich
   auswertet. Nur dann kann die Landkarte nicht vom Code abweichen.
5. **Fix immer an der Quelle.** Ein Bug wird nie in einer Kundeninstanz
   nachgebessert. Wenn eine Instanz sich anders verhält, ist das ein
   Konfigurationsfehler, kein Codefehler.
6. **Ausrollen.** Nach jedem Fix laufen Deployment und Migration über alle
   Instanzen. Dafür braucht es ein Skript unter `scripts/`, das die Kundenliste
   durchgeht. Ohne dieses Skript passiert genau das, was diese Datei verhindern
   soll: Stände driften auseinander.
