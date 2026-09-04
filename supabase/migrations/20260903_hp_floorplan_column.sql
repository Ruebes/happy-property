-- HP-Grundrisse bekommen eine EIGENE Spalte.
-- Vorher schrieb hp-floorplan sein KI-Bild in crm_project_units.floorplan_url —
-- dieselbe Spalte, in die prepare-project-assets den ORIGINAL-Bauträgerplan legt.
-- Zwei Folgen: der Originalplan ging verloren, und der nächtliche Drive-Abgleich
-- übersprang die Wohnung danach für immer (er überspringt jede Wohnung, deren
-- floorplan_url schon gefüllt ist). Damit konnte eine Wohnung mit KI-Bild nie
-- wieder ihren echten Plan bekommen.
alter table crm_project_units add column if not exists hp_floorplan_url text;

comment on column crm_project_units.floorplan_url is
  'ORIGINAL-Grundriss des Bauträgers (aus Drive, zugeordnet von prepare-project-assets). Maßgebliche Quelle für das Deck.';
comment on column crm_project_units.hp_floorplan_url is
  'Verifizierter Grundriss im Happy-Property-Stil (hp-floorplan). Wird nur gesetzt, wenn die Vision-Verifikation bestanden hat.';
