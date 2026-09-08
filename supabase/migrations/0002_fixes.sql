-- =====================================================================
-- 0002 — aniqlangan xatolar tuzatmasi
-- Supabase Dashboard -> SQL Editor -> New query -> shu faylni Run qiling.
-- Bir necha marta ishga tushirish xavfsiz (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) sent_at — natija foydalanuvchiga YUBORILGANINI belgilaydi.
--
-- Muammo: natija Telegram'ga yuborilib, keyin markDone() bazaga yozilmasa
-- (tarmoq uzilishi), job 'processing' holatida qoladi va stale-lock
-- muddatidan keyin qayta olinadi -> foydalanuvchi AYNI natijani IKKI marta
-- oladi. sent_at bo'lsa, ikkinchi urinishda yuborish o'tkazib yuboriladi.
-- ---------------------------------------------------------------------
alter table public.requests
  add column if not exists sent_at timestamptz;

-- ---------------------------------------------------------------------
-- 2) file_unique_id — bir xil faylni takror aniqlashdan saqlaydi (AudD limiti).
-- ---------------------------------------------------------------------
alter table public.requests
  add column if not exists file_unique_id text;

create index if not exists requests_file_unique_idx
  on public.requests (file_unique_id, status)
  where file_unique_id is not null;

-- ---------------------------------------------------------------------
-- 3) claim_next_request tuzatmasi.
--
-- Muammo: `locked_at < now() - interval` — agar locked_at NULL bo'lsa
-- (masalan qo'lda status='processing' qilingan yoki yarim yozilgan qator),
-- SQL'da NULL bilan taqqoslash NULL beradi -> shart hech qachon rost
-- bo'lmaydi va job NAVBATDA ABADIY QOLIB KETADI. coalesce bilan yopiladi.
--
-- Qo'shimcha: eng eski jobni olish uchun tartib (next_attempt_at, id) —
-- bir xil vaqtli joblarda ham barqaror (FIFO) bo'ladi.
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
   where (r.status = 'queued' and r.next_attempt_at <= now())
      or (r.status = 'processing'
          and coalesce(r.locked_at, r.created_at) < now() - make_interval(secs => p_stale_seconds))
   order by r.next_attempt_at asc, r.id asc
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

revoke all on function public.claim_next_request(text, int) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) queue_stats — /health uchun 4 ta alohida COUNT so'rovi o'rniga bitta.
-- ---------------------------------------------------------------------
create or replace function public.queue_stats()
returns table (status text, count bigint)
language sql
security definer
set search_path = public
as $$
  select r.status, count(*)::bigint
    from public.requests r
   group by r.status;
$$;

revoke all on function public.queue_stats() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) user_pending_count — bitta foydalanuvchining navbatdagi joblari soni
--    (spam / AudD limitini himoyalash uchun).
-- ---------------------------------------------------------------------
create or replace function public.user_pending_count(p_user_id bigint)
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*)::bigint
    from public.requests r
   where r.user_id = p_user_id
     and r.status in ('queued', 'processing');
$$;

revoke all on function public.user_pending_count(bigint) from anon, authenticated;
