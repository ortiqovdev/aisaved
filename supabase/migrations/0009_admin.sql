-- =====================================================================
-- 0009 — admin panel (/qimmat): adminlar, majburiy kanallar, statistika
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- Qo'llanmagan bazada bot ishlaydi, faqat admin panel o'chiq bo'ladi.
-- =====================================================================

-- Foydalanuvchi faolligi va holati
alter table public.users add column if not exists last_active_at timestamptz;
-- Botni bloklagan (xabar yuborib bo'lmaydi) — tarqatishda o'tkazib yuboriladi
alter table public.users add column if not exists blocked_at     timestamptz;
-- Admin tomonidan bloklangan — bot javob bermaydi
alter table public.users add column if not exists banned_at      timestamptz;

create index if not exists users_created_at_idx     on public.users (created_at);
create index if not exists users_last_active_at_idx on public.users (last_active_at);

-- Yordamchi adminlar (asosiy admin — ADMIN_TELEGRAM_IDS env'da)
create table if not exists public.admins (
  telegram_id bigint      primary key,
  username    text,
  phone       text,
  added_by    bigint,
  created_at  timestamptz not null default now()
);
alter table public.admins enable row level security;

-- Majburiy a'zolik kanallari
create table if not exists public.required_channels (
  chat_id     bigint      primary key,
  title       text        not null,
  username    text,
  invite_link text,
  added_by    bigint,
  created_at  timestamptz not null default now()
);
alter table public.required_channels enable row level security;

-- Statistika — bitta chaqiruvda (kunlik / haftalik / oylik / yillik)
create or replace function public.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total',        (select count(*) from users),
    'linked',       (select count(*) from users where link_status = 'linked'),
    'blocked',      (select count(*) from users where blocked_at is not null),
    'banned',       (select count(*) from users where banned_at is not null),
    'new_day',      (select count(*) from users where created_at >= now() - interval '1 day'),
    'new_week',     (select count(*) from users where created_at >= now() - interval '7 days'),
    'new_month',    (select count(*) from users where created_at >= now() - interval '30 days'),
    'new_year',     (select count(*) from users where created_at >= now() - interval '365 days'),
    'active_day',   (select count(*) from users where last_active_at >= now() - interval '1 day'),
    'active_week',  (select count(*) from users where last_active_at >= now() - interval '7 days'),
    'active_month', (select count(*) from users where last_active_at >= now() - interval '30 days'),
    'active_year',  (select count(*) from users where last_active_at >= now() - interval '365 days'),
    'req_day',      (select count(*) from requests where created_at >= now() - interval '1 day'),
    'req_week',     (select count(*) from requests where created_at >= now() - interval '7 days'),
    'req_month',    (select count(*) from requests where created_at >= now() - interval '30 days'),
    'failed_day',   (select count(*) from requests where created_at >= now() - interval '1 day' and status = 'failed'),
    'queued',       (select count(*) from requests where status in ('queued', 'processing'))
  );
$$;

revoke execute on function public.admin_stats() from anon, authenticated;
