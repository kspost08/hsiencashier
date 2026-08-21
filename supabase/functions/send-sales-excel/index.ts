// Edge Function:把銷售紀錄查詢結果產生 .xlsx 並用 Resend 寄給指定的收件 Email
// (前端每次寄送都會先跳提示詢問,body.email 沒帶或空字串才退回用 settings.email 當預設)。
// 取代原本 Code.gs 的 sendExcelToEmail(keyword, dateStr, branchName, locationFilter)。
//
// RESEND_API_KEY 從環境變數讀(要在 Supabase Dashboard → Edge Functions → Secrets 手動設定),
// 不寫進程式碼、不進版控。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

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
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  // 用呼叫者自己的 JWT 建 client——查 records 就靠這個 client(套用 RLS),
  // 不用 service_role,因為這裡只是要重新驗證資料、不需要繞過 RLS。
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse({ status: "ERROR", message: "未登入或登入已失效" });
  }

  const { data: callerProfile } = await callerClient
    .from("profiles").select("role").eq("id", user.id).single();

  if (!callerProfile || callerProfile.role !== "ADMIN") {
    return jsonResponse({ status: "ERROR", message: "權限不足" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  if (!resendApiKey) {
    return jsonResponse({ status: "ERROR", message: "尚未設定 RESEND_API_KEY(請到 Edge Function Secrets 設定)" });
  }

  const keyword = String(body.keyword || "").trim().replace(/,/g, "");
  const date = String(body.date || "").trim();
  const locationId = body.locationId ? parseInt(String(body.locationId)) : null;
  const limit = body.limit ? parseInt(String(body.limit)) : 20;

  let query = callerClient.from("records").select("*").order("created_at", { ascending: false }).limit(limit);
  if (keyword) query = query.or(`ticket_id.ilike.%${keyword}%,product_name.ilike.%${keyword}%`);
  if (date) query = query.gte("created_at", `${date}T00:00:00+08:00`).lt("created_at", `${date}T23:59:59.999+08:00`);
  if (locationId) query = query.eq("location_id", locationId);

  const { data: rows, error: rowsError } = await query;
  if (rowsError) {
    return jsonResponse({ status: "ERROR", message: rowsError.message });
  }
  if (!rows || rows.length === 0) {
    return jsonResponse({ status: "ERROR", message: "查無資料,無法寄送" });
  }

  const requestedEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (requestedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail)) {
    return jsonResponse({ status: "ERROR", message: "收件 Email 格式不正確" });
  }

  let recipientEmail = requestedEmail;
  if (!recipientEmail) {
    const { data: settings } = await callerClient.from("settings").select("email").eq("id", 1).single();
    recipientEmail = settings?.email || "";
  }
  if (!recipientEmail) {
    return jsonResponse({ status: "ERROR", message: "尚未提供收件 Email，也沒有系統預設 Email(系統設定)" });
  }

  const { data: locs } = await callerClient.from("locations").select("id,name");
  const locNameById: Record<number, string> = {};
  (locs || []).forEach((l: { id: number; name: string }) => { locNameById[l.id] = l.name; });

  const sheetRows = rows.map((r) => ({
    "時間": new Date(r.created_at).toLocaleString("zh-TW", { hour12: false }),
    "票號": r.ticket_id,
    "品名": r.product_name,
    "單價": r.price,
    "郵票": r.stamp,
    "製作費": r.fee,
    "總額": r.total,
    "發票": r.invoice_num,
    "支局": r.branch,
    "經辦": r.account,
    "地點": locNameById[r.location_id] || "",
  }));

  const worksheet = XLSX.utils.json_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "銷售紀錄");
  const xlsxBase64 = XLSX.write(workbook, { type: "base64", bookType: "xlsx" });

  const fileName = `Sales_Report_${date || "All"}.xlsx`;

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "onboarding@resend.dev",
      to: recipientEmail,
      subject: `📊 銷售報表匯出: ${date || "全部"}`,
      text: `資料筆數:${rows.length} 筆`,
      attachments: [{ filename: fileName, content: xlsxBase64 }],
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    return jsonResponse({ status: "ERROR", message: `寄信失敗: ${errText}` });
  }

  return jsonResponse({ status: "OK" });
});
