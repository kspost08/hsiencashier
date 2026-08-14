# 弦弦收銀機 — Apps Script → GitHub Pages + Supabase 遷移

## 專案背景

現有系統是跑在 Google Apps Script 上的多攤位收銀 POS(高雄郵局企劃行銷科,活動用)。
架構:index.html(前端)+ Code.gs(後端,操作 Google Sheets 當資料庫)+ Customer.html(顧客顯示螢幕,靠 CacheService 輪詢同步)+ Admin.html(後台,內嵌在 index.html 裡)。

目標:前端搬到 GitHub Pages(純靜態網站),資料庫/登入驗證/即時同步/交易鎖定全部換成 Supabase。

原始檔案在 `legacy-gas/` 資料夾,那是唯一的正確業務邏輯來源 —— 照抄邏輯,但實作方式要換成 Supabase 對應功能,不要照抄 Apps Script 的做法(尤其是 LockService 和 CacheService 輪詢那兩段,下面有寫該換成什麼)。

## 已確認的架構決策(不要重新討論,除非發現行不通)

1. **登入用 Supabase Auth**。畫面上員工照樣輸入「員工編號」(不是 email),前端送出前自動組成假 email(例如 `{員工編號}@hsiencashier.local`),呼叫 `supabase.auth.signInWithPassword`。角色(ADMIN / STAFF)和支局存在 `profiles` 表,用 `auth.uid()` 關聯,不要自己刻密碼比對邏輯。
2. **Excel 報表要能一鍵自動寄信**。用 Supabase Edge Function,裡面產生 .xlsx(可以用 SheetJS 或同類套件)再用 Resend(或同等 email API)寄出附件。需要使用者自己申請 email API 的帳號跟 key,寄信 API key 存成 Edge Function secret,不要寫進程式碼。
3. **外部「票券股配票總庫」橋接功能這版不做**。`schedule_stock` 表可以先建起來,但「跨庫轉檔」「讀取別部門 Google Sheet」這些先跳過,不用實作對應功能或 UI。

## 技術棧

- **前端**:純 HTML/JS/CSS,CDN 載入套件,不用 build 工具(沿用現有 index.html 的風格)。`supabase-js` 用 `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>` 載入,不要 npm install / 不要引入 React 或其他框架。
- **後端**:Supabase(Postgres + Auth + Realtime Broadcast + Database Functions/RPC + pg_cron)。
- **Hosting**:GitHub Pages。

## 資料庫 Schema

完整定義見 `supabase/schema.sql`,先跑這個建表。核心表:`locations`、`profiles`、`products`、`product_stock`、`records`、`stock_logs`、`schedule_stock`、`settings`、`master_products`。

`product_stock` 取代原本 Products 表用 G~L 動態欄位代表不同攤位庫存的做法,改成 `(product_id, location_id) -> quantity` 的正規關聯表。

`records` 比原本 Records 分頁多一個 `order_id`(uuid),同一筆結帳的所有品項共用一個 `order_id`——這是取代原本「時間字串相同 = 同一筆訂單」的脆弱比對法,同一秒如果有兩筆不同訂單,舊邏輯會誤判成同一筆。

## 關鍵實作原則

1. **結帳交易安全**:寫一個 `save_order` RPC(plpgsql function,取代 `LockService.getScriptLock()`)。草稿在 `supabase/rpc_save_order_draft.sql`,邏輯是:展開 BOM 算出每個商品要扣的數量 → 用 `SELECT ... FOR UPDATE` 鎖住相關 `product_stock` 列 → 檢查全部足夠才真的扣、寫入 `records` → 任何一項不夠就整筆回滾。**不要**在前端用「先查詢庫存、再判斷、再寫入」三步驟做這件事,兩個人同時結帳會有 race condition,一定要靠資料庫端的鎖。退庫(原本的 `deleteSalesRecord`)也要用同樣模式反向寫一個 `refund_order` RPC。
2. **RLS**:每張表都要開 Row Level Security。STAFF 只能看/寫自己支局(`branch`)的 `records`,ADMIN 可以看全部。判斷身分一律查 `profiles` 表(用 `auth.uid()`),不要相信前端傳來的 role/branch 參數 —— 那些參數在瀏覽器端可以被竄改。
3. **顧客顯示同步**:用 Supabase Realtime Broadcast,頻道 key 用 `pos:{支局}_{攤位}`(對應原本 `combinedBranch`)。不要用輪詢、不要另外建同步用的資料表 —— 這是原本 CacheService 輪詢(每秒打一次)的直接升級,Broadcast 是推播,不用等下一次輪詢。
4. **每日排程補貨**(如果做到這步):用 `pg_cron` 直接呼叫 Postgres function 就好,不需要透過 Edge Function / HTTP,因為邏輯完全在資料庫內部(讀 `schedule_stock`,寫 `product_stock`)。
5. **密碼**:全部交給 Supabase Auth 處理,任何資料表都不存明文或自己雜湊的密碼。後台「帳號管理」頁不能再像原本那樣直接顯示密碼,只能做「重設密碼」的操作。
6. **PDF 報表**:原本 `downloadSalesPDF` 其實沒真的用到它載入的 jsPDF,是組一段 HTML 開新視窗呼叫瀏覽器列印 —— 這段邏輯照搬即可,不用改寫成真的用 jsPDF 產生。

## 安全守則(重要,不要違反)

- Supabase 的 **anon key(現在後台可能顯示為 publishable key)** 可以安全寫進前端程式碼、可以出現在公開 repo,但一定要正確設定 RLS 規則搭配。
- Supabase 的 **service_role key 絕對不能出現在任何前端檔案,不能 commit 進 git**。只能用在:Edge Function 的環境變數(Supabase 會自動注入,不用自己寫進程式碼)、或是本機執行且不進版控的一次性資料搬遷腳本。寫任何程式碼前,如果不確定某個 key 該放哪裡,先問。

## 建議實作順序

- **Phase 0**:套用 `supabase/schema.sql`,設定 RLS policy,設定 Supabase Auth;建立 repo 骨架(`index.html`、`customer.html`,參考 `legacy-gas/` 但不要照搬 Apps Script 專屬 API)。
- **Phase 1**:核心收銀 —— 登入、依攤位讀取商品庫存、購物車、`save_order` RPC、最後存檔檢查。
- **Phase 2**:銷售紀錄查詢、刪除退庫(`refund_order` RPC)。
- **Phase 3**:顧客顯示螢幕(Realtime Broadcast)。
- **Phase 4**:後台 —— 系統設定、帳號管理(改成重設密碼,不顯示明碼)、商品維護。
- **Phase 5**:報表 —— 戰情室 dashboard、PDF(照搬列印邏輯)、Excel 自動寄信(Edge Function + email API)。
- **Phase 6**:資料搬遷(把現有 Google Sheets 資料寫進 Supabase)、兩套並行測試、正式切換。

外部配票總庫橋接(原本的「排程補貨」跨庫轉檔功能)不在這次遷移範圍內,不用實作。

## 工作方式

一次做一個 Phase,做完跟我確認再繼續下一個。遇到我在上面沒寫清楚、需要我決定的地方,先問,不要自己假設。
