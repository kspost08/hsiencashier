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
  scheduled_date date not null,
  location_id int references locations(id),
  order_ref text unique,             -- 配票單號,靠 unique 防止重複轉入(這版先建表,不實作橋接功能)
  items jsonb not null,
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

-- 索引:records 常用查詢欄位
create index if not exists idx_records_branch on records(branch);
create index if not exists idx_records_location on records(location_id);
create index if not exists idx_records_created_at on records(created_at);
create index if not exists idx_records_order_id on records(order_id);
