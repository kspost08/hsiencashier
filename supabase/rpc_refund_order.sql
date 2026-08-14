-- 退庫 RPC,取代原本 Code.gs 裡 deleteSalesRecord() 的做法。
-- legacy 是用「時間字串+票號」定位單一一列刪除退庫;新 schema 有 order_id 之後,
-- 這支 function 以整筆訂單(同一個 order_id 底下所有品項)為單位一起退庫、一起刪除。
--
-- account/branch/role 不接受前端傳入,一律用 auth.uid() 查 profiles 取得,
-- 避免前端偽造權限(同 save_order 的原則)。

create or replace function refund_order(
  p_order_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_branch text;
  v_order_branch text;
  v_row record;
  v_bom text;
  v_comp jsonb;
begin
  -- 0) 身分一律從 auth.uid() 查 profiles
  select role, branch into v_role, v_branch from profiles where id = auth.uid();
  if v_role is null then
    return jsonb_build_object('status', 'ERROR', 'message', '未登入或帳號設定異常');
  end if;

  -- 1) 找出這筆訂單的 branch(同一個 order_id 底下所有列都共用同一個 branch)
  select branch into v_order_branch from records where order_id = p_order_id limit 1;
  if v_order_branch is null then
    return jsonb_build_object('status', 'ERROR', 'message', '找不到這筆訂單');
  end if;

  -- 2) 權限檢查:ADMIN 可退任何支局,STAFF 只能退自己支局
  if v_role <> 'ADMIN' and v_order_branch <> v_branch then
    return jsonb_build_object('status', 'ERROR', 'message', '權限不足');
  end if;

  -- 3) 逐列把庫存加回去(郵票 STAMPS00 沒有庫存可退,跳過)
  for v_row in select * from records where order_id = p_order_id loop
    if v_row.ticket_id <> 'STAMPS00' then
      select bom into v_bom from products where id = v_row.ticket_id;

      if v_bom is not null and v_bom <> '' then
        for v_comp in
          select jsonb_build_object('id', split_part(x,':',1), 'qty', split_part(x,':',2)::int)
          from unnest(string_to_array(v_bom, ',')) as x
        loop
          update product_stock set quantity = quantity + (v_comp->>'qty')::int
            where product_id = v_comp->>'id' and location_id = v_row.location_id;
        end loop;
        update product_stock set quantity = quantity + 1
          where product_id = v_row.ticket_id and location_id = v_row.location_id;
      else
        update product_stock set quantity = quantity + 1
          where product_id = v_row.ticket_id and location_id = v_row.location_id;
      end if;
    end if;
  end loop;

  -- 4) 刪除這筆訂單所有列
  delete from records where order_id = p_order_id;

  return jsonb_build_object('status', 'OK');

exception when others then
  return jsonb_build_object('status', 'ERROR', 'message', sqlerrm);
end;
$$;

revoke all on function refund_order(uuid) from public;
grant execute on function refund_order(uuid) to authenticated;
-- Supabase 對 public schema 的新函式預設會直接 grant execute 給 anon,
-- 跟 Phase 0/1 踩過的同一個坑,這裡要明確對 anon revoke。
revoke execute on function refund_order(uuid) from anon;
