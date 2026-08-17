-- 弦弦收銀機 Supabase schema 草案
-- 這是給 Phase 0 用的起點,執行前請review一次,尤其是 RLS policy(這份檔案先只建表,
-- RLS policy 建議跟 Claude Code 討論後再另外補上,因為要精確對應「STAFF只能看自己支局」等規則)

create table if not exists locations (
  id serial primary key,
  name text unique not null,
  sort_order int default 0
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  account text unique not null,      -- 員工編號,例如 E001
  branch text not null,              -- 支局
  role text not null check (role in ('ADMIN','STAFF')),
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
  order_ref text not null,           -- 配票單號,一個單號底下可以有多列品項(不是 unique)
  branch text,                       -- 支局(純記錄用,實際扣/補庫存是靠 location_id)
  ticket_id text not null,           -- 票號,對應 products.id
  product_name text not null,        -- 票品名稱,新增時可從 master_products 帶入,個別可再編輯
  qty int not null,                  -- 要補的數量
  applied_at timestamptz,            -- 是否已套用補貨(手動套用或 pg_cron 自動套用都會寫入)
  created_at timestamptz default now()
);

create table if not exists settings (
  id int primary key default 1,
  title text,
  version text,
  notice text,
  activity_url text,
  email text,
  check (id = 1)
);

create table if not exists master_products (
  ticket_id text primary key,
  name text,
  price numeric,
  stamp numeric,
  fee numeric,
  total numeric
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
  created_at timestamptz default now(),
  unique (order_ref, ticket_id)
);

-- 索引:records 常用查詢欄位
create index if not exists idx_records_branch on records(branch);
create index if not exists idx_records_location on records(location_id);
create index if not exists idx_records_created_at on records(created_at);
create index if not exists idx_records_order_id on records(order_id);

-- 索引:schedule_stock 常用查詢欄位
create index if not exists idx_schedule_stock_order_ref on schedule_stock(order_ref);
create index if not exists idx_schedule_stock_pending on schedule_stock(scheduled_date) where applied_at is null;
