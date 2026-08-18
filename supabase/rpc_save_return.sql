-- 歸票 RPC,取代原本 Apps Script 版「弦弦歸票計算機」的 saveReturn()。
-- legacy 是現場清點退回票品時,把整批品項寫入 Return_Master 分頁(單純紀錄/日誌)。
--
-- 這支 function 除了寫 return_records 當日誌/對帳用,還會把歸還數量加回原配票單
-- 指定的活動地點(activity_name 對應 locations.name)的 product_stock——歸還=庫存+1,
-- 不分天/分人拆算,單純把票品還給原本的攤位庫存。找不到對應地點(activity_name 沒有
-- 建過 locations,或票號還沒在「商品維護」建立過)就跳過庫存更新,但 return_records
-- 照樣寫入,不擋歸票流程(回傳 stock_updated:false 讓前端知會使用者)。
--
-- account/branch/role 不接受前端傳入,一律用 auth.uid() 查 profiles 取得,
-- 避免前端偽造權限(同 save_order / refund_order 的原則)。

create or replace function save_return_order(
  p_ref_order_ref text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_branch text;
  v_account text;
  v_alloc_branch text;
  v_alloc_activity text;
  v_alloc_date date;
  v_return_id text;
  v_location_id int;
  item jsonb;
begin
  -- 0) 身分一律從 auth.uid() 查 profiles
  select role, branch, account into v_role, v_branch, v_account from profiles where id = auth.uid();
  if v_role is null then
    return jsonb_build_object('status', 'ERROR', 'message', '未登入或帳號設定異常');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('status', 'ERROR', 'message', '歸還清單是空的');
  end if;

  -- 1) 找出這張配票單歸屬的支局/活動/日期(同一個 order_ref 底下所有列都共用)
  select branch, activity_name, scheduled_date
    into v_alloc_branch, v_alloc_activity, v_alloc_date
    from allocation_records where order_ref = p_ref_order_ref limit 1;

  if v_alloc_branch is null then
    return jsonb_build_object('status', 'ERROR', 'message', '找不到配票單號 ' || p_ref_order_ref);
  end if;

  -- 2) 權限檢查:ADMIN 可歸還任何支局,STAFF 只能歸還自己支局的配票單
  if v_role <> 'ADMIN' and v_alloc_branch <> v_branch then
    return jsonb_build_object('status', 'ERROR', 'message', '無權限操作其他支局的配票單');
  end if;

  -- 3) 產生歸票單號(R+毫秒級時間戳),整批寫入
  v_return_id := 'R' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS');

  insert into return_records
    (return_order_id, ref_order_ref, ref_scheduled_date, activity_name, branch,
     ticket_id, product_name, unit_price, qty, total_amount, reduction_val, fee_total, account)
  select
    v_return_id, p_ref_order_ref, v_alloc_date, v_alloc_activity, v_alloc_branch,
    item->>'ticket_id', item->>'product_name',
    (item->>'unit_price')::numeric, (item->>'qty')::numeric, (item->>'total_amount')::numeric,
    coalesce((item->>'reduction_val')::numeric, 0), coalesce((item->>'fee_total')::numeric, 0),
    v_account
  from jsonb_array_elements(p_items) as item;

  -- 4) 把歸還數量加回原活動地點的庫存(找不到對應地點就跳過,不擋歸票)
  select id into v_location_id from locations where name = v_alloc_activity;

  if v_location_id is not null then
    for item in select * from jsonb_array_elements(p_items) loop
      if item->>'ticket_id' <> 'STAMPS00' then
        if not exists (select 1 from products where id = item->>'ticket_id') then
          insert into products (id, name, price, stamp, fee, total)
          select item->>'ticket_id', coalesce(mp.name, item->>'product_name'),
                 coalesce(mp.price, 0), coalesce(mp.stamp, 0), coalesce(mp.fee, 0), coalesce(mp.total, 0)
          from (select 1) as dummy
          left join master_products mp on mp.ticket_id = item->>'ticket_id'
          on conflict (id) do nothing;
        end if;

        insert into product_stock (product_id, location_id, quantity)
          values (item->>'ticket_id', v_location_id, (item->>'qty')::int)
          on conflict (product_id, location_id)
          do update set quantity = product_stock.quantity + excluded.quantity;

        insert into stock_logs (product_id, qty, account, location_id)
          values (item->>'ticket_id', (item->>'qty')::int, v_account, v_location_id);
      end if;
    end loop;
  end if;

  return jsonb_build_object('status', 'OK', 'return_order_id', v_return_id, 'stock_updated', v_location_id is not null);

exception when others then
  return jsonb_build_object('status', 'ERROR', 'message', sqlerrm);
end;
$$;

revoke all on function save_return_order(text, jsonb) from public;
grant execute on function save_return_order(text, jsonb) to authenticated;
-- Supabase 對 public schema 的新函式預設會直接 grant execute 給 anon,
-- 跟 Phase 0/1 踩過的同一個坑,這裡要明確對 anon revoke。
revoke execute on function save_return_order(text, jsonb) from anon;
