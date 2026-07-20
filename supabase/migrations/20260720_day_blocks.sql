-- „Rest des Tages blocken" (20.07.2026)
--
-- Sven will in der Tages-Ansicht per Klick verhindern, dass Kunden den Rest des
-- Tages noch buchen — ohne dass daraus ein gebuchter Termin wird.
--
-- Datenmodell: eine Zeile in crm_appointments mit kind='block' und internal=true.
-- Begruendung gegen eine eigene Tabelle: crm_appointments ist die Tabelle, die ALLE
-- Buchungswege ohnehin auf belegte Zeiten abfragen (funnel-api, personal-booking,
-- booking-bot). Eine Sperre dort wirkt automatisch ueberall — auch in einem
-- Buchungsweg, den es heute noch gar nicht gibt. Eine separate Tabelle waere in der
-- gefaehrlichen Richtung fail-open: vergisst jemand eine Quelle anzuschliessen,
-- bucht ein Kunde in gesperrte Zeit.
--
-- internal=true erbt zusaetzlich alle bereits vorhandenen Filter (naechtlicher
-- Check, Meta-Conversions, Terminerinnerungen, Pipeline-Markierung, Vorbereitungs-
-- Popup), siehe 20260720_internal_appointments.sql. kind trennt davon sauber die
-- Frage „ist das ueberhaupt ein Termin": Gionas internes Meeting soll Sven sehen,
-- eine Sperre nicht als Termin.

alter table crm_appointments add column if not exists kind text not null default 'appointment';
alter table crm_appointments drop constraint if exists crm_appointments_kind_check;
alter table crm_appointments add constraint crm_appointments_kind_check check (kind in ('appointment','block'));
create index if not exists idx_crm_appt_kind on crm_appointments(kind) where kind = 'block';
