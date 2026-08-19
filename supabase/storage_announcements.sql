-- 攤位活動公告改成上傳圖片/PDF(取代原本貼 Google 文件發布網址的做法)。
-- 建一個 public bucket,ADMIN 可寫,任何人(含未登入)可讀 —— 登入畫面本身就要能顯示。

insert into storage.buckets (id, name, public)
values ('announcements', 'announcements', true)
on conflict (id) do nothing;

create policy "announcements_admin_insert"
  on storage.objects for insert
  with check (bucket_id = 'announcements' and current_profile_role() = 'ADMIN');

create policy "announcements_admin_update"
  on storage.objects for update
  using (bucket_id = 'announcements' and current_profile_role() = 'ADMIN');

create policy "announcements_admin_delete"
  on storage.objects for delete
  using (bucket_id = 'announcements' and current_profile_role() = 'ADMIN');
