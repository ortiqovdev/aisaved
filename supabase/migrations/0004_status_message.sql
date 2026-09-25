-- =====================================================================
-- 0004 — status xabari
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
--
-- Foydalanuvchiga bitta xabar boradi: "⏳ Qabul qilindi" kartasi yuboriladi
-- va ish tugagach AYNAN SHU xabar videoga / rasmga / natijaga aylantiriladi.
-- Worker o'sha xabarni topishi uchun uning ID'si shu yerda saqlanadi.
-- Qo'llanmagan bazada ham ishlaydi — ID faqat jarayon xotirasida turadi
-- (server qayta ishga tushsa, natija yangi xabar bo'lib keladi).
-- =====================================================================

alter table public.requests
  add column if not exists status_message_id bigint;
