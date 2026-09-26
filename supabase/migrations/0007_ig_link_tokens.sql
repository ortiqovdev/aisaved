-- =====================================================================
-- 0007 — bir bosishda bog'lash (Instagram → Telegram, kodsiz)
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- Qo'llanmagan bazada ham bot ishlaydi — kalitlar xotirada saqlanadi
-- (server qayta ishga tushsa, foydalanuvchi havolani qayta so'raydi).
--
-- Oqim: bog'lanmagan foydalanuvchi Instagram'da yozadi → bot bir martalik
-- kalit bilan t.me/<bot>?start=ig_<token> havolasini yuboradi → Telegram'da
-- START → kalit iste'mol qilinadi va IGSID shu Telegram foydalanuvchisiga
-- bog'lanadi. Bog'lanishdan oldin yuborilgan reels'lar (pending) shundan
-- keyin yetkaziladi.
-- =====================================================================

create table if not exists public.ig_link_tokens (
  token        text        primary key,
  ig_scoped_id text        not null,
  -- Bog'lanishdan oldin yuborilgan media: [{url, type, downloadable, mid}]
  pending      jsonb       not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz
);

create index if not exists ig_link_tokens_igsid_idx
  on public.ig_link_tokens (ig_scoped_id)
  where used_at is null;

-- Faqat service_role (server) ishlatadi — tashqaridan hech kim o'qiy olmaydi
alter table public.ig_link_tokens enable row level security;
