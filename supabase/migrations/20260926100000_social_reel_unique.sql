-- Ein Drive-Reel darf nur EINEM Autopilot-Slot gehören (parallele Läufe, z. B.
-- Cron + „Jetzt schon erstellen", könnten sonst dasselbe Video zweimal reservieren).
-- Verworfene/gelöschte Autopilot-Posts bleiben als status 'verworfen' stehen
-- (Grabstein), damit der Slot nicht neu erzeugt wird.
create unique index if not exists social_posts_drive_reel_uq on social_posts (news_source) where news_source like 'drive:%';
