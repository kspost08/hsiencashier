-- 配票單號集中領取機制。任何登入的呼叫端(這個 repo 的「下載匯入範本」按鈕、
-- 「手動新增單筆配票項目」表單,或未來獨立的配票專用入口——都是同一個 Supabase
-- 專案、都要登入)呼叫這支 function 就能拿到一個全域唯一、不會撞號的配票單號。
--
-- 格式:PC + 當日日期(YYYYMMDD) + 當日序號兩碼,例如 PC20260818-01,每天從 01 重新起算。
-- 用 insert ... on conflict do update ... returning 這個 Postgres 保證原子性的計數器
-- 寫法,併發領取不會發出同一個號碼給不同呼叫端,不需要額外的 FOR UPDATE 鎖。
--
-- 每次呼叫都會真的消耗一個號碼,即使最後沒有實際填表/上傳,那個號碼就是被跳過——
-- 這是集中發號機制預期內、可接受的行為,不需要「歸還」號碼的機制。

create or replace function claim_allocation_order_ref() returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_counter int;
begin
  insert into order_ref_counters (ref_date, counter) values (v_today, 1)
    on conflict (ref_date) do update set counter = order_ref_counters.counter + 1
    returning counter into v_counter;
  return 'PC' || to_char(v_today, 'YYYYMMDD') || '-' || lpad(v_counter::text, 2, '0');
end;
$$;

revoke all on function claim_allocation_order_ref() from public;
grant execute on function claim_allocation_order_ref() to authenticated;
-- Supabase 對 public schema 的新函式預設會直接 grant execute 給 anon,
-- 跟其他 RPC 一樣要明確對 anon revoke。
revoke execute on function claim_allocation_order_ref() from anon;
