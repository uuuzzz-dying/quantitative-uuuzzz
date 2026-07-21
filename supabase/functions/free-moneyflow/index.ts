import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const output = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function currentUserId(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("未登录");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new Error("登录信息无效");
  return data.user.id;
}

async function getJson(url: string, attempt = 0): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json,text/plain,*/*",
        Referer: "https://data.eastmoney.com/",
      },
    });
    if (!response.ok) throw new Error(`免费资金源返回 ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const config: Record<string, { fid: string; fields: string }> = {
  today: { fid: "f62", fields: "f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f124" },
  d5: { fid: "f164", fields: "f12,f14,f2,f109,f164,f165,f166,f167,f168,f169,f124" },
  d10: { fid: "f174", fields: "f12,f14,f2,f160,f174,f175,f176,f177,f178,f179,f124" },
};
const marketFilter = "m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:3+f:!2";

async function rankingPage(kind: string, page: number) {
  const selected = config[kind];
  const params = new URLSearchParams({
    fid: selected.fid,
    po: "1",
    pz: "100",
    pn: String(page),
    np: "1",
    fltt: "2",
    invt: "2",
    ut: "b2884a393a59ad64002292a3e90d46a5",
    fs: marketFilter,
    fields: selected.fields,
  });
  const payload = await getJson(`https://push2.eastmoney.com/api/qt/clist/get?${params}`);
  const diff = payload?.data?.diff || [];
  const rows = Array.isArray(diff) ? diff : Object.values(diff);
  return { total: Number(payload?.data?.total || 0), rows: rows as Record<string, unknown>[] };
}

async function ranking(kind: string) {
  const first = await rankingPage(kind, 1);
  if (!first.rows.length) throw new Error(`免费资金源暂时没有返回${kind}数据`);
  const pageCount = Math.min(70, Math.ceil(first.total / 100));
  const rows = [...first.rows];
  for (let start = 2; start <= pageCount; start += 6) {
    const pages = Array.from({ length: Math.min(6, pageCount - start + 1) }, (_, index) => start + index);
    const group = await Promise.all(pages.map((page) => rankingPage(kind, page)));
    rows.push(...group.flatMap((item) => item.rows));
  }
  return rows;
}

const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
function fundScore(today: any, d5: any, d10: any) {
  let score = 50;
  const add = (input: unknown, high: number, middle: number) => {
    const value = number(input);
    if (value === null) return;
    if (value >= 5) score += high;
    else if (value >= 1) score += middle;
    else if (value <= -5) score -= high;
    else if (value <= -1) score -= middle;
  };
  add(today?.f184, 12, 6);
  add(d5?.f165, 15, 8);
  add(d10?.f175, 12, 6);
  const superPct = number(today?.f69);
  const largePct = number(today?.f75);
  const change = number(today?.f3);
  const mainPct = number(today?.f184);
  if (superPct !== null && largePct !== null) {
    if (superPct > 0 && largePct > 0) score += 5;
    else if (superPct < 0 && largePct < 0) score -= 5;
  }
  if (mainPct !== null && change !== null) {
    if (mainPct > 2 && change < 0) score += 3;
    if (mainPct < -2 && change > 0) score -= 5;
  }
  return clamp(score);
}

function tradeDate(timestamp: unknown) {
  const value = number(timestamp);
  if (value) return new Date(value * 1000).toISOString().slice(0, 10);
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

async function sync(userId: string) {
  console.log("[free-moneyflow] sync started", { user_id: userId });
  const [today, five, ten] = await Promise.all([ranking("today"), ranking("d5"), ranking("d10")]);
  const todayMap = new Map(today.map((row: any) => [String(row.f12), row]));
  const fiveMap = new Map(five.map((row: any) => [String(row.f12), row]));
  const tenMap = new Map(ten.map((row: any) => [String(row.f12), row]));
  const { data: stocks, error } = await db.from("quant_stocks").select("id,code").eq("user_id", userId).eq("enabled", true);
  if (error) throw error;
  const rows = (stocks || []).map((stock: any) => {
    const todayRow: any = todayMap.get(String(stock.code));
    const fiveRow: any = fiveMap.get(String(stock.code));
    const tenRow: any = tenMap.get(String(stock.code));
    if (!todayRow && !fiveRow && !tenRow) return null;
    const score = fundScore(todayRow, fiveRow, tenRow);
    return {
      user_id: userId,
      stock_id: stock.id,
      trade_date: tradeDate(todayRow?.f124 || fiveRow?.f124 || tenRow?.f124),
      latest_price: number(todayRow?.f2 || fiveRow?.f2 || tenRow?.f2),
      today_pct_change: number(todayRow?.f3),
      today_main_net: number(todayRow?.f62),
      today_main_pct: number(todayRow?.f184),
      today_super_net: number(todayRow?.f66),
      today_super_pct: number(todayRow?.f69),
      today_large_net: number(todayRow?.f72),
      today_large_pct: number(todayRow?.f75),
      d5_pct_change: number(fiveRow?.f109),
      d5_main_net: number(fiveRow?.f164),
      d5_main_pct: number(fiveRow?.f165),
      d10_pct_change: number(tenRow?.f160),
      d10_main_net: number(tenRow?.f174),
      d10_main_pct: number(tenRow?.f175),
      fund_score: score,
      fund_signal: score >= 70 ? "资金偏强" : score < 40 ? "资金偏弱" : "资金中性",
      source: "eastmoney-free",
      fetched_at: new Date().toISOString(),
    };
  }).filter(Boolean);
  for (let index = 0; index < rows.length; index += 500) {
    const { error: upsertError } = await db.from("quant_moneyflow_latest").upsert(rows.slice(index, index + 500), { onConflict: "user_id,stock_id" });
    if (upsertError) throw upsertError;
  }
  console.log("[free-moneyflow] sync finished", { user_id: userId, market_rows: today.length, matched: rows.length });
  return { market_rows: today.length, matched: rows.length, library_size: (stocks || []).length, trade_date: rows[0]?.trade_date || null, source: "eastmoney-free" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userId = await currentUserId(req);
    const action = new URL(req.url).searchParams.get("action") || "status";
    if (action === "sync") return output(await sync(userId));
    return output({ ok: true, source: "eastmoney-free" });
  } catch (error) {
    console.error("[free-moneyflow] request failed", error);
    return output({ error: error instanceof Error ? error.message : "免费资金服务失败" }, 400);
  }
});
