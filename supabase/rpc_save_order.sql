-- 結帳 RPC,取代原本 Code.gs 裡 saveOrder() + LockService 的做法。
-- 用 SELECT ... FOR UPDATE 鎖住這次要扣的 product_stock 列,全部足夠才真的扣、寫入 records,
-- 任何一項不夠就整筆回滾(PL/pgSQL 的 EXCEPTION 區塊會自動 rollback 到這個函式呼叫開始前)。
--
-- account/branch 不接受前端傳入,一律用 auth.uid() 查 profiles 取得,
-- 避免前端偽造 branch/account 寫進 records(對應 CLAUDE.md「不要相信前端傳來的 role/branch 參數」)。

create or replace function save_order(
  p_items jsonb,        -- [{"id":"A001","name":"...","price":100,"stamp":0,"fee":0,"total":100}, ...]
  p_invoice text,
  p_location_id int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account text;
  v_branch text;
  v_order_id uuid := gen_random_uuid();
  v_item jsonb;
  v_bom text;
  v_comp jsonb;
  v_deduct jsonb := '{}'::jsonb;   -- {product_id: 要扣的數量}
  v_pid text;
  v_qty text;
  v_have int;
begin
  -- 0) 身分一律從 auth.uid() 查 profiles,不接受前端傳入的 account/branch
  select account, branch into v_account, v_branch from profiles where id = auth.uid();
  if v_account is null then
    return jsonb_build_object('status', 'ERROR', 'message', '未登入或帳號設定異常');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('status', 'ERROR', 'message', '購物車是空的');
  end if;

  -- 1) 展開每個品項(含 BOM 組合包),把要扣的庫存彙總到 v_deduct
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := v_item->>'id';
    if v_pid = 'STAMPS00' then continue; end if;  -- 郵票不扣庫存

    select bom into v_bom from products where id = v_pid;

    if v_bom is not null and v_bom <> '' then
      -- 拆解 "A001:2,B002:1" 這種格式
      for v_comp in
        select jsonb_build_object('id', split_part(x,':',1), 'qty', split_part(x,':',2)::int)
        from unnest(string_to_array(v_bom, ',')) as x
      loop
        v_deduct := jsonb_set(v_deduct, array[v_comp->>'id'],
          to_jsonb(coalesce((v_deduct->>(v_comp->>'id'))::int,0) + (v_comp->>'qty')::int));
      end loop;
    end if;

    -- 商品本身(組合包或單品)都要扣 1 個名額
    v_deduct := jsonb_set(v_deduct, array[v_pid],
      to_jsonb(coalesce((v_deduct->>v_pid)::int,0) + 1));
  end loop;

  -- 2) 鎖住相關列並檢查庫存是否足夠(取代 LockService)
  for v_pid, v_qty in select * from jsonb_each_text(v_deduct) loop
    select quantity into v_have from product_stock
      where product_id = v_pid and location_id = p_location_id
      for update;
    if v_have is null or v_have < v_qty::int then
      raise exception '庫存不足: %', v_pid;
    end if;
  end loop;

  -- 3) 扣庫存
  for v_pid, v_qty in select * from jsonb_each_text(v_deduct) loop
    update product_stock set quantity = quantity - v_qty::int
      where product_id = v_pid and location_id = p_location_id;
  end loop;

  -- 4) 寫入銷售紀錄(同一個 order_id),branch/account 用伺服器端查到的值,不用前端傳的
  insert into records (order_id, ticket_id, product_name, price, stamp, fee, total,
                        invoice_num, branch, account, location_id)
  select v_order_id, x->>'id', x->>'name',
         (x->>'price')::numeric, (x->>'stamp')::numeric, (x->>'fee')::numeric, (x->>'total')::numeric,
         p_invoice, v_branch, v_account, p_location_id
  from jsonb_array_elements(p_items) as x;

  return jsonb_build_object('status', 'OK', 'order_id', v_order_id);

exception when others then
  -- 走到這裡代表上面某個環節失敗(通常是庫存不足),
  -- PL/pgSQL 在有 EXCEPTION 區塊時,函式內先前的 update/insert 會自動 rollback
  return jsonb_build_object('status', 'ERROR', 'message', sqlerrm);
end;
$$;

-- 只有登入使用者能呼叫;anon 呼叫也會在函式一開始因為查不到 profile 被擋掉,
-- 不像 current_profile_role()/current_profile_branch() 那樣需要開放給 anon
-- (這個 function 不會被任何 RLS policy 引用,所以沒有「規劃階段就需要 EXECUTE 權限」的問題)。
revoke all on function save_order(jsonb, text, int) from public;
grant execute on function save_order(jsonb, text, int) to authenticated;
-- Supabase 對 public schema 的新函式預設會直接 grant execute 給 anon(不只是透過 public 繼承),
-- 跟 Phase 0 踩過的同一個坑,這裡要明確對 anon revoke。
revoke execute on function save_order(jsonb, text, int) from anon;
