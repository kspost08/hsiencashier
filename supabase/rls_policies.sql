-- 弦弦收銀機 RLS policy
-- 套用順序:先跑 schema.sql 建表,再跑這份。
-- 判斷身分一律查 profiles 表(用 auth.uid()),不相信前端傳來的 role/branch 參數。

-- ============================================================
-- 輔助 function:security definer 繞過 RLS,避免 profiles 自己的
-- policy 裡查 profiles 造成遞迴。
-- ============================================================

create or replace function current_profile_role() returns text
language sql security definer stable
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function current_profile_branch() returns text
language sql security definer stable
set search_path = public
as $$
  select branch from profiles where id = auth.uid()
$$;

-- 注意:這兩個 function 不能 revoke anon 的 EXECUTE 權限。
-- Postgres 規劃 RLS 時,只要表上「有任何一條 policy」引用了這個 function,
-- 查詢角色就需要對它有 EXECUTE 權限,即使實際上不會走到那條 policy
-- (例如 settings 表同時有 authenticated-select 跟 admin-write-all 兩條 policy,
-- anon 查 select 時 Postgres 仍需要能對 admin-write-all 用到的 current_profile_role() 求值,
-- 沒有 EXECUTE 權限的話整個查詢會直接 42501 permission denied,不是「只是評估為 false」)。
-- 這兩個 function 本身沒有資料外洩風險:anon 呼叫只會拿到 null,因為 auth.uid() 是 null。
grant execute on function public.current_profile_role() to anon, authenticated, service_role;
grant execute on function public.current_profile_branch() to anon, authenticated, service_role;

-- ============================================================
-- 開啟 RLS
-- ============================================================

alter table locations enable row level security;
alter table profiles enable row level security;
alter table products enable row level security;
alter table product_stock enable row level security;
alter table records enable row level security;
alter table stock_logs enable row level security;
alter table schedule_stock enable row level security;
alter table settings enable row level security;
alter table master_products enable row level security;
alter table allocation_records enable row level security;

-- ============================================================
-- profiles:只能看自己那筆,或 ADMIN 看全部。
-- 沒有 INSERT/DELETE policy —— 帳號建立/刪除只能靠 service_role
-- (種子腳本、admin-users Edge Function),前端不能直接寫。
-- UPDATE 只開放 ADMIN 改別人的 branch/role(不涉及密碼,密碼一律
-- 走 Edge Function 呼叫 auth.admin.updateUserById)。
-- ============================================================

create policy "profiles_select_own_or_admin"
  on profiles for select
  using (id = auth.uid() or current_profile_role() = 'ADMIN');

create policy "profiles_update_admin"
  on profiles for update
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- locations:所有登入者可讀,只有 ADMIN 可寫。
-- ============================================================

create policy "locations_select_authenticated"
  on locations for select
  using (auth.role() = 'authenticated');

create policy "locations_write_admin"
  on locations for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- products / master_products:所有登入者可讀,只有 ADMIN 可寫。
-- ============================================================

create policy "products_select_authenticated"
  on products for select
  using (auth.role() = 'authenticated');

create policy "products_write_admin"
  on products for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

create policy "master_products_select_authenticated"
  on master_products for select
  using (auth.role() = 'authenticated');

create policy "master_products_write_admin"
  on master_products for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- product_stock:所有登入者可讀(收銀時要能查任一攤位庫存)。
-- 只有 ADMIN 能直接寫;STAFF 的異動一律走 SECURITY DEFINER RPC
-- (save_order / refund_order,Phase 1-2 才會定案),RPC 本身不受
-- RLS 限制,不需要額外的 policy 讓 STAFF 直接寫這張表。
-- ============================================================

create policy "product_stock_select_authenticated"
  on product_stock for select
  using (auth.role() = 'authenticated');

create policy "product_stock_write_admin"
  on product_stock for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- records:STAFF 只能看自己支局(branch)的,ADMIN 看全部。
-- 沒有 INSERT/UPDATE/DELETE policy —— 只能走 save_order /
-- refund_order RPC(security definer),前端不能直接寫。
-- ============================================================

create policy "records_select_own_branch_or_admin"
  on records for select
  using (branch = current_profile_branch() or current_profile_role() = 'ADMIN');

-- ============================================================
-- stock_logs:先當作查閱用途(不像 records 有金流敏感度),
-- 所有登入者可讀可寫,對應 legacy 庫存管理 tab 任何登入者都能操作。
-- 這是假設,不是 CLAUDE.md 明文規定,之後如果要收斂成走 RPC 或
-- 分支局隔離,再回來調整。
-- ============================================================

create policy "stock_logs_select_authenticated"
  on stock_logs for select
  using (auth.role() = 'authenticated');

create policy "stock_logs_insert_authenticated"
  on stock_logs for insert
  with check (auth.role() = 'authenticated');

-- ============================================================
-- schedule_stock:這版不做跨庫橋接,先保守鎖住,只有 ADMIN 可讀可寫。
-- ============================================================

create policy "schedule_stock_admin_only"
  on schedule_stock for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- allocation_records:配票紀錄 Excel 匯入暫存區,只有 ADMIN 可讀可寫。
-- ============================================================

create policy "allocation_records_admin_only"
  on allocation_records for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');

-- ============================================================
-- settings:任何人可讀(含未登入),因為登入畫面本身就要顯示
-- title/version/notice——這些欄位本來就不是機密資料。
-- 只有 ADMIN 可寫。
-- ============================================================

create policy "settings_select_public"
  on settings for select
  using (true);

create policy "settings_write_admin"
  on settings for all
  using (current_profile_role() = 'ADMIN')
  with check (current_profile_role() = 'ADMIN');
