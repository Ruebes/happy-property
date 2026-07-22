-- Posteingang: gelesen/ungelesen. Sven: „die Mails wechseln nicht auf gelesen,
-- wenn ich sie anklicke." Der blaue Punkt = ungelesene eingehende Nachricht;
-- beim Öffnen der Konversation werden ihre eingehenden Nachrichten als gelesen
-- markiert. Bestand bleibt NULL (= ungelesen), damit die vorhandenen Punkte
-- stehen bleiben und einzeln verschwinden, wenn Sven sie öffnet.
alter table activities add column if not exists read_at timestamptz;
