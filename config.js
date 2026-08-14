// Supabase 專案設定。anon/publishable key 可以安全寫進前端、進公開 repo,
// 但一定要搭配正確的 RLS 規則(見 supabase/rls_policies.sql)。
// 絕對不要把 service_role key 放進這個檔案。
//
const SUPABASE_URL = 'https://ruqezpttzeprsqbeufud.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_p1rsWYk1Me_bz0p-1j4pmQ_bYpkfOZW';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
