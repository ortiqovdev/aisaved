-- =====================================================================
-- 0003 — foydalanuvchi tili
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
--
-- Bot ko'p tilli: til /language orqali tanlanadi yoki Telegram'dagi
-- interfeys tilidan aniqlanadi. Worker natijani foydalanuvchining tilida
-- yuborishi uchun u bazada saqlanadi (worker'da Telegram `language_code`
-- yo'q). Qo'llanmagan bazada ham bot ishlaydi — til faqat jarayon
-- xotirasida turadi va qayta ishga tushganda yo'qoladi.
-- =====================================================================

alter table public.users
  add column if not exists language text;

-- Kod faqat ma'lum tillarni yozadi; qo'lda noto'g'ri qiymat kiritilmasin.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_language_check'
  ) then
    alter table public.users
      add constraint users_language_check
      check (language is null or language in ('en', 'uz', 'ru', 'ar', 'kk', 'tr'));
  end if;
end $$;
