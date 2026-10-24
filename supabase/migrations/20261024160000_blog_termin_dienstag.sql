-- Blog-Autopilot: Erscheinungstag Dienstag 07:00 Zypern statt Montag (Sven 24.10.26: Social-Posts
-- nie zeitgleich mit anderen Posts). Montags laufen schon die YouTube-Wochenposts (LinkedIn 08:30,
-- Facebook/Instagram 18:30). Dienstag: LinkedIn übernimmt den Autopilot-Platz 08:30, Facebook und
-- Instagram 12:30 (sonst nur das Reel um 18:30).
create or replace function public.blog_naechster_termin()
returns timestamptz
language plpgsql stable security definer set search_path = public
as $$
declare
  tag date := (now() at time zone 'Asia/Nicosia')::date;
  t   timestamptz;
begin
  for i in 1..400 loop
    tag := tag + 1;
    if extract(isodow from tag) = 2 then
      t := (tag::timestamp + time '07:00') at time zone 'Asia/Nicosia';
      if t > now() + interval '36 hours' and not exists (
        select 1 from blog_artikel
        where status in ('freigegeben', 'geplant', 'veroeffentlicht') and geplant_fuer = t
      ) then
        return t;
      end if;
    end if;
  end loop;
  return null;
end $$;
