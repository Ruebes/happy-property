-- Hook im Bild: A/B-Test und Auswertung.
--
-- Hintergrund (Recherche 27.9.2026): fuer Karussell-Cover ist die Studienlage
-- eindeutig, fuer Text auf Einzelbildern nicht (Fanpage Karma misst +38 %
-- Reichweite, Agorapulse das Gegenteil). Das laesst sich nur an der eigenen
-- Zielgruppe entscheiden, also wird abwechselnd mit und ohne Hook gepostet und
-- hinterher verglichen.
--
-- image_hook = der Text, der unten IM Bild steht. NULL = Bild ohne Text.
-- Karussell-Cover tragen ihren Hook immer, dort steht der Titel der ersten Slide.
alter table social_posts add column if not exists image_hook text;

comment on column social_posts.image_hook is
  'Hook-Text im Bild (Overlay). NULL = Bild ohne Text. Grundlage fuer den A/B-Vergleich in social_format_performance.';

-- Auswertung je Format und Hook-Zustand. Nur Posts, die das CRM selbst
-- veroeffentlicht hat (social_post_id gesetzt), sonst fehlt die Zuordnung.
create or replace view social_format_performance as
select
  m.platform,
  m.snapshot,
  case
    when p.video_url is not null then 'reel'
    when p.format = 'carousel'   then 'karussell'
    else 'einzelbild'
  end                                as format,
  (p.image_hook is not null)         as hook_im_bild,
  count(*)                           as posts,
  round(avg(m.reach))                as reichweite_schnitt,
  round(avg(m.views))                as aufrufe_schnitt,
  round(avg(m.saves), 2)             as speicherungen_schnitt,
  round(avg(m.shares), 2)            as geteilt_schnitt,
  round(avg(m.likes), 2)             as likes_schnitt,
  round(avg(m.comments), 2)          as kommentare_schnitt
from social_post_metrics m
join social_posts p on p.id = m.social_post_id
group by 1, 2, 3, 4;

comment on view social_format_performance is
  'Reichweite je Format und Hook-Zustand. Aussagekraeftig erst ab etwa 10 Posts je Zeile.';

-- Lesen wie bei den Metriken selbst: Team im Studio.
alter view social_format_performance set (security_invoker = on);
