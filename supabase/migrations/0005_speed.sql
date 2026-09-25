-- =====================================================================
-- 0005 — tezlik: bitta so'rovda navbatga qo'yish + media keshi
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- Qo'llanmagan bazada ham bot ishlaydi — eski (sekinroq) yo'l bilan.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) enqueue_request — limit tekshiruvi + navbatga qo'yish BITTA so'rovda.
--
-- Ilgari har bir havolada 2 ta alohida so'rov ketardi (navbatdagilar sonini
-- sanash, keyin insert). Supabase'gacha bitta so'rov ~0.5 s bo'lgani uchun
-- bu foydalanuvchi javobini sezilarli sekinlashtirardi.
--
-- Natija: {"status":"queued","id":..} | {"status":"limit","pending":n}
--         | {"status":"duplicate"}
-- ---------------------------------------------------------------------
create or replace function public.enqueue_request(
  p_user_id           bigint,
  p_ig_message_id     text,
  p_media_url         text,
  p_media_type        text,
  p_file_unique_id    text,
  p_status_message_id bigint,
  p_max_pending       int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending int;
  v_id      bigint;
begin
  select count(*)
    into v_pending
    from public.requests r
   where r.user_id = p_user_id
     and r.status in ('queued', 'processing');

  if v_pending >= p_max_pending then
    return jsonb_build_object('status', 'limit', 'pending', v_pending);
  end if;

  insert into public.requests
    (user_id, ig_message_id, media_url, media_type, status, file_unique_id, status_message_id)
  values
    (p_user_id, p_ig_message_id, p_media_url, p_media_type, 'queued', p_file_unique_id, p_status_message_id)
  on conflict (ig_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  return jsonb_build_object('status', 'queued', 'id', v_id);
end;
$$;

-- security definer — faqat service_role chaqira olsin (0002 dagi qoida)
revoke all on function public.enqueue_request(bigint, text, text, text, text, bigint, int)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) media_cache — Instagram post → Telegram file_id.
--
-- Bir marta yuborilgan reels/postni keyingi safar RapidAPI'siz, yuklab
-- olmasdan, Telegram'dagi file_id orqali ~bir soniyada yuboramiz.
-- Virusli reelslarni ko'p odam yuboradi — RapidAPI limiti ham tejaladi.
--
-- items: [{"kind": "video"|"photo", "file_id": "..."}]
-- ---------------------------------------------------------------------
create table if not exists public.media_cache (
  shortcode  text        primary key,
  items      jsonb       not null,
  created_at timestamptz not null default now()
);

-- RLS yoqilgan, policy'siz — faqat service_role (backend) o'qiy/yoza oladi
alter table public.media_cache enable row level security;
