-- Social-Media-Autopilot: plant und postet Reels, Lotte-Posts und News selbst.
-- autopilot_slot = "<YYYY-MM-DD>|<art>" (Zypern-Datum); eindeutig, damit parallele
-- Cron-Läufe denselben Slot nie doppelt befüllen.
alter table social_posts add column if not exists autopilot_slot text;
create unique index if not exists social_posts_autopilot_slot_uq on social_posts (autopilot_slot) where autopilot_slot is not null;

insert into social_topics (key, label, icon, sort) values ('reel', 'Reel', '🎞️', 35)
  on conflict (key) do nothing;
update social_topics set label = 'Lotte' where key = 'weisheit';

-- Wochenplan (Zypern-Zeit, dow 0 = Sonntag). Montags läuft das YouTube-Video
-- (youtube_post), deshalb dort kein Reel.
insert into crm_settings (key, value, updated_at) values ('social_autopilot', '{
  "enabled": true,
  "reels_folder": "12ylh3GVlyAxeO9yY2-VPzE49CgavDIV0",
  "lotte_folder": "18Rr5A50N2KvTpE3a5ZOsa-bFuC0KEyMM",
  "social_folder": "12UYSCJZHcVHyreIejPGKytvU5Rl9238e",
  "reel_platforms": ["facebook", "instagram"],
  "slots": [
    {"dow": 2, "kind": "reel", "time": "18:30"},
    {"dow": 3, "kind": "reel", "time": "18:30"},
    {"dow": 4, "kind": "reel", "time": "18:30"},
    {"dow": 5, "kind": "reel", "time": "18:30"},
    {"dow": 6, "kind": "reel", "time": "18:30"},
    {"dow": 0, "kind": "reel", "time": "18:30"},
    {"dow": 1, "kind": "news", "time": "12:30"},
    {"dow": 2, "kind": "news", "time": "12:30", "li_time": "08:30"},
    {"dow": 4, "kind": "news", "time": "12:30", "li_time": "08:30"},
    {"dow": 5, "kind": "news", "time": "12:30", "li_time": "08:30"},
    {"dow": 0, "kind": "news", "time": "12:30"},
    {"dow": 3, "kind": "lotte", "time": "12:30"},
    {"dow": 6, "kind": "lotte", "time": "12:30"}
  ]
}', now()) on conflict (key) do nothing;

-- Lotte-Referenzfotos: neuer Ordner "Happy Property Marke/Social Media/Lotte Bilder"
-- (für den Service-Account sichtbar, Sven legt dort nach und nach Fotos ab).
update crm_settings
   set value = jsonb_set(value::jsonb, '{lotte_folder}', '"18Rr5A50N2KvTpE3a5ZOsa-bFuC0KEyMM"')::text,
       updated_at = now()
 where key = 'social_persona_refs';
