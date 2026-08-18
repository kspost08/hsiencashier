-- 補貨用的原子寫入 RPC,取代前端「先查庫存、再算新數量、再寫入」的三步驟做法
-- (跟 rpc_save_order.sql 的理由一樣:併發時三步驟做法會漏算,一定要靠資料庫端原子操作)。
-- 這一顆是「單一商品」補貨,給庫存管理頁的「補貨」按鈕用,也是配票單批次套用的底層邏輯。

create or replace function restock_product(
  p_product_id text,
  p_location_id int,
  p_qty int
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account text;
  v_role text;
begin
  select account, role into v_account, v_role from profiles where id = auth.uid();
  if v_role is distinct from 'ADMIN' then
    raise exception '權限不足,補貨僅限管理員操作';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception '補貨數量必須大於 0';
  end if;

  insert into product_stock (product_id, location_id, quantity)
    values (p_product_id, p_location_id, p_qty)
    on conflict (product_id, location_id)
    do update set quantity = product_stock.quantity + excluded.quantity;

  insert into stock_logs (product_id, qty, account, location_id)
    values (p_product_id, p_qty, v_account, p_location_id);
end;
$$;

revoke all on function restock_product(text, int, int) from public;
grant execute on function restock_product(text, int, int) to authenticated;
revoke execute on function restock_product(text, int, int) from anon;

-- 配票單批次套用:找出某個配票單號底下所有還沒套用的品項,逐一套用同一段補貨邏輯,
-- 全部成功才整批 commit(單一 function 呼叫本身就在同一個交易裡,失敗會自動整批 rollback)。
--
-- product_stock.product_id 有外鍵指到 products.id,如果這個票號還沒在「商品維護」建立過
-- 商品,直接補貨會撞外鍵失敗。現在改成:套用時如果 products 還沒有這個票號,就用
-- master_products(票品主檔)現場建一筆——單價用 total(price+stamp+fee 合計,對應
-- allocation.html/歸票清點用的同一套慣例),主檔也查不到就用 schedule_stock 裡存的品名、
-- 金額算 0(不擋補貨流程,之後還是可以到「商品維護」手動修正)。
create or replace function apply_schedule_stock_order(
  p_order_ref text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account text;
  v_role text;
  r record;
  v_count int := 0;
begin
  select account, role into v_account, v_role from profiles where id = auth.uid();
  if v_role is distinct from 'ADMIN' then
    return jsonb_build_object('status', 'ERROR', 'message', '權限不足,補貨僅限管理員操作');
  end if;

  for r in
    select * from schedule_stock
    where order_ref = p_order_ref and applied_at is null
    for update
  loop
    if not exists (select 1 from products where id = r.ticket_id) then
      insert into products (id, name, price, stamp, fee, total)
      select r.ticket_id, coalesce(mp.name, r.product_name),
             coalesce(mp.price, 0), coalesce(mp.stamp, 0), coalesce(mp.fee, 0), coalesce(mp.total, 0)
      from (select 1) as dummy
      left join master_products mp on mp.ticket_id = r.ticket_id
      on conflict (id) do nothing;
    end if;

    insert into product_stock (product_id, location_id, quantity)
      values (r.ticket_id, r.location_id, r.qty)
      on conflict (product_id, location_id)
      do update set quantity = product_stock.quantity + excluded.quantity;

    insert into stock_logs (product_id, qty, account, location_id)
      values (r.ticket_id, r.qty, v_account, r.location_id);

    update schedule_stock set applied_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('status', 'OK', 'applied_count', v_count);
exception when others then
  return jsonb_build_object('status', 'ERROR', 'message', sqlerrm);
end;
$$;

revoke all on function apply_schedule_stock_order(text) from public;
grant execute on function apply_schedule_stock_order(text) to authenticated;
revoke execute on function apply_schedule_stock_order(text) from anon;

-- pg_cron 每日自動套用:找出所有排定日期已到、還沒套用的配票項目,自動套用。
-- 這顆不透過前端呼叫,直接由 pg_cron 排程觸發,SECURITY DEFINER 繞過 RLS 沒問題。
-- 一樣套用上面「products 沒有就用 master_products 現場建立」的邏輯,理由相同。
create or replace function apply_due_schedule_stock() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select * from schedule_stock
    where scheduled_date <= (now() at time zone 'Asia/Taipei')::date and applied_at is null
    for update
  loop
    if not exists (select 1 from products where id = r.ticket_id) then
      insert into products (id, name, price, stamp, fee, total)
      select r.ticket_id, coalesce(mp.name, r.product_name),
             coalesce(mp.price, 0), coalesce(mp.stamp, 0), coalesce(mp.fee, 0), coalesce(mp.total, 0)
      from (select 1) as dummy
      left join master_products mp on mp.ticket_id = r.ticket_id
      on conflict (id) do nothing;
    end if;

    insert into product_stock (product_id, location_id, quantity)
      values (r.ticket_id, r.location_id, r.qty)
      on conflict (product_id, location_id)
      do update set quantity = product_stock.quantity + excluded.quantity;

    insert into stock_logs (product_id, qty, account, location_id)
      values (r.ticket_id, r.qty, 'pg_cron', r.location_id);

    update schedule_stock set applied_at = now() where id = r.id;
  end loop;
end;
$$;

-- 這顆函式沒有角色檢查(靠 pg_cron 內部觸發、不是給前端呼叫的),Supabase 對 public schema
-- 新函式預設會直接 grant execute 給 anon/authenticated,一定要明確 revoke,
-- 不然任何人都能打 /rest/v1/rpc/apply_due_schedule_stock 提早觸發全部套用。
revoke all on function apply_due_schedule_stock() from public;
revoke execute on function apply_due_schedule_stock() from anon;
revoke execute on function apply_due_schedule_stock() from authenticated;

-- 建立每日排程(台北時間 06:00 = UTC 前一天 22:00,在營業開始前套用當天配票)
select cron.schedule(
  'daily-apply-schedule-stock',
  '0 22 * * *',
  $$select apply_due_schedule_stock();$$
);
