-- =====================================================================
-- InstaReel-to-Telegram — boshlang'ich sxema
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni to'liq
-- qo'yib "Run" bosing.
-- =====================================================================

-- ---------------------------------------------------------------------
-- users: Telegram foydalanuvchisi <-> Instagram-Scoped ID bog'lanishi
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id                  bigint generated always as identity primary key,
  telegram_id         bigint      not null unique,
  telegram_username   text,
  telegram_first_name text,
  ig_scoped_id        text        unique,          -- bog'langandan keyin to'ldiriladi
  link_code           text        unique,          -- vaqtinchalik bog'lash kodi (LINK-XXXXXX)
  link_status         text        not null default 'pending'
                        check (link_status in ('pending', 'linked')),
  created_at          timestamptz not null default now(),
  linked_at           timestamptz,
  -- bog'langan userda IGSID albatta bo'lishi shart
  constraint users_linked_requires_igsid
    check (link_status <> 'linked' or ig_scoped_id is not null)
);

create index if not exists users_link_code_idx    on public.users (link_code)    where link_code is not null;
create index if not exists users_ig_scoped_id_idx on public.users (ig_scoped_id) where ig_scoped_id is not null;

-- ---------------------------------------------------------------------
-- requests: har bir yuborilgan reels. Ayni paytda navbat (queue) vazifasini
-- ham bajaradi — alohida Redis kerak emas.
--
-- status oqimi:
--   queued -> processing -> done
--                       \-> queued (retry, next_attempt_at kechiktiriladi)
--                       \-> failed (attempts >= MAX_ATTEMPTS yoki doimiy xato)
-- ---------------------------------------------------------------------
create table if not exists public.requests (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references public.users(id) on delete cascade,
  ig_message_id   text        unique,              -- Meta webhook'ni qayta yuborsa dublikat bo'lmasligi uchun
  media_url       text        not null,
  media_type      text,                            -- ig_reel | video | share ...
  status          text        not null default 'queued'
                    check (status in ('queued', 'processing', 'done', 'failed')),
  attempts        int         not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  video_file_path text,
  song_title      text,
  song_artist     text,
  song_album      text,
  song_link       text,
  error_message   text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

-- Worker aynan shu tartibda o'qiydi
create index if not exists requests_queue_idx
  on public.requests (status, next_attempt_at);

create index if not exists requests_user_idx
  on public.requests (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- claim_next_request: navbatdan bitta jobni ATOMIK tarzda "band qiladi".
--
-- FOR UPDATE SKIP LOCKED tufayli bir nechta worker parallel ishlaganda ham
-- bitta job ikki marta olinmaydi.
-- Shuningdek "osilib qolgan" joblarni (worker qulab tushgan bo'lsa)
-- p_stale_seconds dan keyin qayta oladi.
-- ---------------------------------------------------------------------
create or replace function public.claim_next_request(
  p_worker_id     text,
  p_stale_seconds int default 300
)
returns setof public.requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  select r.id
    into v_id
    from public.requests r
   where (r.status = 'queued'     and r.next_attempt_at <= now())
      or (r.status = 'processing' and r.locked_at < now() - make_interval(secs => p_stale_seconds))
   order by r.next_attempt_at asc
   limit 1
     for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update public.requests
       set status    = 'processing',
           locked_at = now(),
           locked_by = p_worker_id,
           attempts  = attempts + 1
     where id = v_id
    returning *;
end;
$$;

-- ---------------------------------------------------------------------
-- RLS: hamma jadval yopiq. Backend service_role kaliti bilan ishlaydi va
-- RLS'ni chetlab o'tadi — ya'ni bu ma'lumotlarga tashqaridan (anon key
-- bilan) hech kim tegolmaydi.
-- ---------------------------------------------------------------------
alter table public.users    enable row level security;
alter table public.requests enable row level security;

revoke all on function public.claim_next_request(text, int) from anon, authenticated;
