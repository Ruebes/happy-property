-- Angekreuzte Wünsche aus dem „Mehr Infos“-Formular, für das Anschreiben im Anfrage-Paket (24.10.2026).
alter table public.anfrage_pakete add column if not exists wuensche text[];
