-- =====================================================================
-- 0006 — qo'shiq natijasi keshi
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- Qo'llanmagan bazada ham ishlaydi — eski (faqat topilganlar) kesh bilan.
--
-- AudD har bir so'rov uchun pul oladi, bitta bosish esa 3 tagacha so'rov
-- (videoning bir necha joyidan parcha). Bitta reels'ni ko'p odam bossa —
-- AudD faqat birinchi marta chaqiriladi.
--
--   song = to'liq natija (nom, ijrochi, Spotify/Apple, muqova)
--   song = null — "topilmadi" (kod 24 soatdan keyin qayta tekshiradi:
--          AudD bazasiga qo'shiq keyinroq qo'shilishi mumkin)
-- ---------------------------------------------------------------------
create table if not exists public.song_cache (
  file_unique_id text        primary key,   -- Telegram file_unique_id (fayl mazmuni)
  song           jsonb,
  created_at     timestamptz not null default now()
);

-- RLS yoqilgan, policy'siz — faqat service_role (backend) o'qiy/yoza oladi
alter table public.song_cache enable row level security;
