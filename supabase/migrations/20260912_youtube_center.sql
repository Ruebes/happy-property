-- ── YouTube-Center: Videos vorbereiten, hochladen, freigeben ─────────────────
-- Eine Zeile je Video (Entwurf → hochgeladen → Freigabe → veröffentlicht).
-- Der Upload läuft direkt Browser → YouTube (Resumable Session, vom Server mit
-- Origin-Header eröffnet), deshalb liegt hier NUR Metadaten + Workflow, kein Video.
-- Zugriff: Admin/Verwalter immer, Mitarbeiter mit Recht "youtube".

create table if not exists yt_videos (
  id                 uuid primary key default gen_random_uuid(),
  video_id           text unique,
  title              text not null default '',
  description        text not null default '',
  tags               text[] not null default '{}',
  category_id        text not null default '26',
  language           text not null default 'de',
  privacy            text not null default 'private'
                     check (privacy in ('private','unlisted','public')),
  publish_at         timestamptz,
  playlist_id        text,
  playlist_title     text,
  thumbnail_url      text,
  yt_thumbnail       text,
  duration_sec       integer,
  notify_subscribers boolean not null default true,
  made_for_kids      boolean not null default false,
  status             text not null default 'entwurf'
                     check (status in ('entwurf','laedt','hochgeladen','freigabe','freigegeben','veroeffentlicht','fehler')),
  brief              text,
  ai                 jsonb,
  ai_pending         boolean not null default false,
  ai_error           text,
  upload_session     text,
  upload_size        bigint,
  upload_name        text,
  upload_mime        text,
  uploaded_by        uuid references profiles(id) on delete set null,
  approved_by        uuid references profiles(id) on delete set null,
  approved_at        timestamptz,
  approval_task_id   uuid,
  published_at       timestamptz,
  stats              jsonb,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists yt_videos_status_idx on yt_videos (status, created_at desc);

alter table yt_videos enable row level security;
drop policy if exists yt_videos_staff on yt_videos;
create policy yt_videos_staff on yt_videos
  for all to authenticated
  using (current_user_has_perm('youtube'))
  with check (current_user_has_perm('youtube'));

-- Standard-Footer für Beschreibungen (einmal pflegen, überall anhängen)
insert into crm_settings (key, value) values ('yt_description_footer',
'━━━━━━━━━━━━━━━━━━━━━━
🏝️ Happy Property Cyprus – Neubau-Kapitalanlagen auf Zypern für deutschsprachige Investoren

📅 Kostenloses Erstgespräch: https://happy-property.de/termin
🌐 Website: https://happy-property.de
📸 Instagram: https://www.instagram.com/happy_property_cyprus
💼 LinkedIn: https://www.linkedin.com/in/sven-rüprich/
📘 Facebook: https://www.facebook.com/profile.php?id=61573780546599

Hinweis: Keine Anlageberatung. Alle Zahlen sind Beispiele und keine Garantie.')
on conflict (key) do nothing;

insert into crm_settings (key, value) values ('yt_default_tags',
'Zypern Immobilien,Immobilien Zypern kaufen,Kapitalanlage Zypern,Auswandern Zypern,Paphos Immobilien,Happy Property Cyprus,Zypern Steuern,Immobilien Investment')
on conflict (key) do nothing;
