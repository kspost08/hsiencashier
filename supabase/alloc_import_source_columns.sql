-- 匯入「票券異動明細表」到 allocation.html 用的來源追蹤欄位。
-- source_seq_no:明細表的「序號」,同一批匯入共用同一個值,拿來防呆「這份檔案是不是已經匯入過」。
-- source_txn_date:明細表的「帳務日」(民國年字串,例如 "115/08/18"),純參考,不驅動 scheduled_date。
-- 兩欄都是 nullable——既有手動配票(allocation.html 手動加入清單)不會有這兩個值。

alter table allocation_records add column if not exists source_seq_no text;
alter table allocation_records add column if not exists source_txn_date text;

create index if not exists idx_allocation_records_source_seq on allocation_records(source_seq_no);
