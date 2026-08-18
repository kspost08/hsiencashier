// Edge Function:帳號管理的特權操作(新增帳號 / 重設密碼 / 刪除帳號)。
// 這三個操作都要呼叫 auth.admin.* API,必須用 service_role key,
// 所以不能在前端做,一律走這支 Edge Function。
//
// service_role key 從環境變數讀(Supabase 平台自動注入),不寫進程式碼、不進版控。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 前端是從瀏覽器直接呼叫這支 Edge Function(跨網域),一定要處理 CORS,
// 不然瀏覽器連 preflight OPTIONS 都會被擋,導致整個呼叫連送出去都沒辦法。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少授權" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 用呼叫者自己的 JWT 驗證身分 + 查 profiles.role,不接受前端宣稱的角色。
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse({ status: "ERROR", message: "未登入或登入已失效" });
  }

  const { data: callerProfile } = await callerClient
    .from("profiles").select("account, role").eq("id", user.id).single();

  if (!callerProfile || callerProfile.role !== "ADMIN") {
    return jsonResponse({ status: "ERROR", message: "權限不足" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const action = body.action;

  try {
    if (action === "create") {
      const account = String(body.account || "").trim();
      const password = String(body.password || "");
      const branch = String(body.branch || "").trim();
      const role = String(body.role || "");
      if (!account || !password || !branch || (role !== "ADMIN" && role !== "STAFF" && role !== "ALLOC")) {
        return jsonResponse({ status: "ERROR", message: "缺少必要欄位" });
      }

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: `${account}@hsiencashier.local`,
        password,
        email_confirm: true,
      });
      if (createError) {
        return jsonResponse({ status: "ERROR", message: createError.message });
      }

      const { error: profileError } = await admin.from("profiles").insert({
        id: created.user.id, account, branch, role,
      });
      if (profileError) {
        // 避免留下沒有 profile 的孤兒 auth 使用者
        await admin.auth.admin.deleteUser(created.user.id);
        return jsonResponse({ status: "ERROR", message: profileError.message });
      }

      return jsonResponse({ status: "OK" });
    }

    if (action === "reset_password") {
      const account = String(body.account || "").trim();
      const password = String(body.password || "");
      if (!account || !password) {
        return jsonResponse({ status: "ERROR", message: "缺少必要欄位" });
      }

      const { data: prof } = await admin.from("profiles").select("id").eq("account", account).single();
      if (!prof) {
        return jsonResponse({ status: "ERROR", message: "找不到帳號" });
      }

      const { error } = await admin.auth.admin.updateUserById(prof.id, { password });
      if (error) {
        return jsonResponse({ status: "ERROR", message: error.message });
      }

      return jsonResponse({ status: "OK" });
    }

    if (action === "delete") {
      const account = String(body.account || "").trim();
      if (!account) {
        return jsonResponse({ status: "ERROR", message: "缺少必要欄位" });
      }
      if (account === callerProfile.account) {
        return jsonResponse({ status: "ERROR", message: "不能刪除自己目前登入的帳號" });
      }

      const { data: prof } = await admin.from("profiles").select("id").eq("account", account).single();
      if (!prof) {
        return jsonResponse({ status: "ERROR", message: "找不到帳號" });
      }

      // profiles 那筆會透過 on delete cascade 自動一起刪除
      const { error } = await admin.auth.admin.deleteUser(prof.id);
      if (error) {
        return jsonResponse({ status: "ERROR", message: error.message });
      }

      return jsonResponse({ status: "OK" });
    }

    return jsonResponse({ status: "ERROR", message: "未知的操作" });
  } catch (e) {
    return jsonResponse({ status: "ERROR", message: String((e as Error).message || e) });
  }
});
