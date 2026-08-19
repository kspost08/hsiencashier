-- 弦弦收銀機 Supabase schema 草案
-- 這是給 Phase 0 用的起點,執行前請review一次,尤其是 RLS policy(這份檔案先只建表,
-- RLS policy 建議跟 Claude Code 討論後再另外補上,因為要精確對應「STAFF只能看自己支局」等規則)

create table if not exists locations (
  id serial primary key,
  name text unique not null,
  sort_order int default 0
);

-- 支局主檔(局號/局名/局等),取代原本各處「從既有帳號資料反推支局清單」的做法。
-- 這是唯讀參照資料(郵局官方支局清單),資料本身用 code(局號)當 PK;
-- profiles/records/schedule_stock/allocation_records/return_records 的 branch 欄位
-- 仍然維持自由文字(格式 "局號 局名"),不做外鍵約束——只是把「選支局」的下拉選單
-- 統一改成讀這張表,不是把既有 5 張表的 branch 欄位改型別(影響範圍太大,詳見討論)。
create table if not exists branches (
  code text primary key,   -- 局號,例如 "004150"
  name text not null,      -- 局名,例如 "高雄大順-50支"
  grade text                -- 局等,例如 "特"/"甲"/"乙"/"丙"/"丁"
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  account text unique not null,      -- 員工編號,例如 E001
  branch text not null,              -- 支局(ALLOC 角色不隸屬任何支局,這欄只是湊 NOT NULL,填哪個支局都不影響權限判斷)
  role text not null check (role in ('ADMIN','STAFF','ALLOC')),  -- ALLOC = 配票單位專用,見 allocation.html
  created_at timestamptz default now()
);

create table if not exists products (
  id text primary key,               -- 票號
  name text not null,
  price numeric default 0,
  stamp numeric default 0,
  fee numeric default 0,
  total numeric default 0,
  bom text,                          -- 沿用 "A001:2,B002:1" 格式
  row_order int,
  created_at timestamptz default now()
);

create table if not exists product_stock (
  product_id text references products(id) on delete cascade,
  location_id int references locations(id) on delete cascade,
  quantity int not null default 0,
  primary key (product_id, location_id)
);

create table if not exists records (
  id bigint generated always as identity primary key,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  ticket_id text not null,
  product_name text not null,
  price numeric,
  stamp numeric,
  fee numeric,
  total numeric,
  invoice_num text,
  branch text,
  account text,
  location_id int references locations(id)
);

create table if not exists stock_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  product_id text,
  qty int,
  account text,
  location_id int references locations(id)
);

create table if not exists schedule_stock (
  id bigint generated always as identity primary key,
  scheduled_date date not null,      -- 配票日期,pg_cron 每天檢查這個欄位
  location_id int references locations(id),
  order_ref text not null,           -- 配票單號,一個單號底下可以有多列品項
  branch text,                       -- 支局(純記錄用,實際扣/補庫存是靠 location_id)
  ticket_id text not null,           -- 票號,對應 products.id
  product_name text not null,        -- 票品名稱,新增時可從 master_products 帶入,個別可再編輯
  qty int not null,                  -- 要補的數量
  applied_at timestamptz,            -- 是否已套用補貨(pg_cron 自動套用時寫入)
  created_at timestamptz default now(),
  unique (order_ref, ticket_id)      -- 同一張配票單只能整批加入排程一次,不能分批追加同一票號
);

create table if not exists settings (
  id int primary key default 1,
  title text,
  version text,
  notice text,
  activity_urls text[] default '{}',  -- 攤位活動公告圖片/PDF,存 Supabase Storage 的 public URL,可多張
  email text,
  check (id = 1)
);

create table if not exists master_products (
  ticket_id text primary key,
  name text,
  price numeric,
  stamp numeric,
  fee numeric,
  total numeric,
  issue_date text                    -- 發行日期(民國年字串,例如 "108/05/20"),歸票計算機算「降庫業績」用
);

-- 配票紀錄 Excel 匯入的原始資料(對應高雄郵局內部匯出格式),
-- 只是暫存區,實際要排程補貨的品項還是要「勾選加入」才會寫進 schedule_stock。
create table if not exists allocation_records (
  id bigint generated always as identity primary key,
  order_ref text not null,           -- 配票單號(一單可以有多列品項)
  scheduled_date date not null,      -- 配票日期(Excel 序號換算)
  activity_name text,                -- 活動名稱,用來對照 locations.name
  branch text,                       -- 配票支局(純記錄用)
  ticket_id text not null,           -- 類別+票品+票號 組成,對應 products.id
  product_name text,                 -- 中文說明
  qty numeric not null,
  unit_price numeric,
  total_amount numeric,
  added_to_schedule_at timestamptz,  -- 已勾選加入 schedule_stock 就寫入,避免重複加入
  source_seq_no text,                -- 若是從「票券異動明細表」匯入,這是明細表的「序號」,匯入防呆用來源識別碼
  source_txn_date text,              -- 明細表的「帳務日」(民國年字串),純參考,不驅動 scheduled_date
  created_at timestamptz default now(),
  unique (order_ref, ticket_id)
);

-- 歸票紀錄(現場清點退回票品),一筆歸還批次(return_order_id)底下有多列品項。
-- 純粹是紀錄/日誌,不會反向增加 product_stock 庫存(照抄 legacy 歸票計算機邏輯)。
create table if not exists return_records (
  id bigint generated always as identity primary key,
  return_order_id text not null,     -- 歸票單號,R+時間戳,同一批共用
  ref_order_ref text,                -- 原配票單號(allocation_records.order_ref)
  ref_scheduled_date date,           -- 原配票日期快照
  activity_name text,                -- 活動名稱快照
  branch text not null,              -- 歸票支局
  ticket_id text not null,           -- 類別+票品+票號
  product_name text,                 -- 中文說明
  unit_price numeric,
  qty numeric not null,
  total_amount numeric,
  reduction_val numeric default 0,   -- 降庫業績(發行滿2年才有值)
  fee_total numeric default 0,       -- AP製作費小計
  account text,                      -- 操作人員(員工編號)
  created_at timestamptz not null default now()
);

create index if not exists idx_return_records_return_order on return_records(return_order_id);
create index if not exists idx_return_records_branch on return_records(branch);
create index if not exists idx_allocation_records_source_seq on allocation_records(source_seq_no);

-- 配票單號集中領取用的每日計數器。只有 claim_allocation_order_ref() 這支
-- SECURITY DEFINER function 會碰這張表,前端/其他呼叫端不會直接讀寫它。
create table if not exists order_ref_counters (
  ref_date date primary key,
  counter int not null default 0
);

-- 索引:records 常用查詢欄位
create index if not exists idx_records_branch on records(branch);
create index if not exists idx_records_location on records(location_id);
create index if not exists idx_records_created_at on records(created_at);
create index if not exists idx_records_order_id on records(order_id);

-- 索引:schedule_stock 常用查詢欄位
create index if not exists idx_schedule_stock_order_ref on schedule_stock(order_ref);
create index if not exists idx_schedule_stock_pending on schedule_stock(scheduled_date) where applied_at is null;
