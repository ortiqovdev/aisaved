-- =====================================================================
-- 0008 — ilova holati (kalit → qiymat)
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- Qo'llanmagan bazada ham bot ishlaydi — qiymatlar xotirada turadi.
--
-- Nima saqlanadi:
--   ig_token            — avtomatik yangilangan Instagram access token (~60 kun
--                         amal qiladi; bot haftada bir yangilaydi). Render
--                         env'ini ilovaning o'zi o'zgartira olmaydi, shuning
--                         uchun yangisi shu yerda turadi.
--   users_milestone     — oxirgi "har 500 foydalanuvchi" hisoboti
-- =====================================================================

create table if not exists public.app_kv (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- Faqat service_role (server) ishlatadi — tashqaridan hech kim o'qiy olmaydi
alter table public.app_kv enable row level security;
