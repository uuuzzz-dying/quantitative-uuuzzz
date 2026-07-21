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

async function getJson(url: string, timeout = 14_000, attempt = 0): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json,text/plain,*/*",
        Referer: "https://quote.eastmoney.com/",
      },
    });
    if (!response.ok) throw new Error(`外部行情源返回 ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      return getJson(url, timeout, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const quoteSymbol = (code: string) => /^(4|8|92)/.test(code)
  ? `${code}.BJ`
  : /^(5|6|9)/.test(code) ? `${code}.SS` : `${code}.SZ`;
const market = (code: string) => /^(688|689)/.test(code)
  ? "科创板"
  : /^(300|301)/.test(code) ? "创业板" : /^(4|8|92)/.test(code) ? "北交所" : /^6/.test(code) ? "上海主板" : "深圳主板";
const exchange = (code: string) => /^(4|8|92)/.test(code)
  ? "Beijing"
  : /^(5|6|9)/.test(code) ? "Shanghai" : "Shenzhen";
const secid = (code: string) => `${/^(5|6|9)/.test(code) && !/^92/.test(code) ? 1 : 0}.${code}`;
const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const standardDeviation = (values: number[]) => {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
};
const percentage = (current: number, previous: number) => previous ? (current / previous - 1) * 100 : 0;
const fixed = (value: number, digits = 2) => Number(value).toFixed(digits);

function rsi(closes: number[], period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function analyze(bars: any[]) {
  bars = bars
    .filter((row) => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => a.time.localeCompare(b.time));
  if (bars.length < 35) throw new Error("K线少于35个交易日");
  const closes = bars.map((row) => row.close);
  const volumes = bars.map((row) => row.volume || 0);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const ma5 = avg(closes.slice(-5));
  const ma10 = avg(closes.slice(-10));
  const ma20 = avg(closes.slice(-20));
  const ma60 = closes.length >= 60 ? avg(closes.slice(-60)) : null;
  const rsi14 = rsi(closes);
  const return5 = percentage(latest.close, closes.at(-6));
  const return20 = percentage(latest.close, closes.at(-21));
  const dayChange = percentage(latest.close, previous.close);
  const high20 = Math.max(...bars.slice(-20).map((row) => row.high));
  const distanceFromHigh20 = percentage(latest.close, high20);
  const averageVolume20 = avg(volumes.slice(-21, -1));
  const volumeRatio = latest.volume > 0 && averageVolume20 > 0 ? latest.volume / averageVolume20 : null;
  const recentCloses = closes.slice(-21);
  const volatility20 = standardDeviation(recentCloses.slice(1).map((value, index) => percentage(value, recentCloses[index]))) * Math.sqrt(252);
  let score = 50;
  let trendScore = 0;
  let momentumScore = 0;
  let volumeScore = 0;
  let riskScore = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (latest.close > ma20) {
    score += 12; trendScore += 12; reasons.push("收盘价站在20日均线上方，中期趋势偏强");
  } else {
    score -= 12; trendScore -= 12; risks.push("收盘价位于20日均线下方，中期趋势尚弱");
  }
  if (ma5 > ma10 && ma10 > ma20) {
    score += 12; trendScore += 12; reasons.push("MA5、MA10、MA20呈多头排列");
  } else if (ma5 < ma10 && ma10 < ma20) {
    score -= 12; trendScore -= 12; risks.push("短中期均线呈空头排列");
  }
  if (ma60 !== null) {
    const change = latest.close > ma60 ? 6 : -6;
    score += change; trendScore += change;
  }
  if (return20 >= 3 && return20 <= 20) {
    score += 8; momentumScore += 8; reasons.push(`近20日上涨${fixed(return20)}%，动量为正但未极端`);
  } else if (return20 > 20) {
    score += 2; momentumScore += 2; risks.push(`近20日已上涨${fixed(return20)}%，追高风险增加`);
  } else if (return20 <= -8) {
    score -= 8; momentumScore -= 8; risks.push(`近20日下跌${fixed(Math.abs(return20))}%，趋势仍需修复`);
  }
  if (rsi14 !== null) {
    if (rsi14 >= 45 && rsi14 <= 68) {
      score += 7; momentumScore += 7; reasons.push(`RSI14为${fixed(rsi14, 1)}，处于健康区间`);
    } else if (rsi14 > 75) {
      score -= 7; momentumScore -= 7; risks.push(`RSI14为${fixed(rsi14, 1)}，短期可能过热`);
    } else if (rsi14 < 35) {
      score -= 5; momentumScore -= 5; risks.push(`RSI14为${fixed(rsi14, 1)}，弱势超卖不等于马上反弹`);
    }
  }
  if (volumeRatio !== null) {
    if (volumeRatio >= 1.15 && dayChange > 0) {
      score += 7; volumeScore += 7; reasons.push(`量比${fixed(volumeRatio)}，上涨得到成交量确认`);
    } else if (volumeRatio >= 1.5 && dayChange < 0) {
      score -= 8; volumeScore -= 8; risks.push("放量下跌，卖盘压力需要警惕");
    } else if (volumeRatio < 0.65) {
      score -= 2; volumeScore -= 2; risks.push("成交量明显低于20日均量");
    }
  }
  if (distanceFromHigh20 >= -3) {
    score += 5; momentumScore += 5; reasons.push("股价接近20日高点，市场相对强势");
  }
  if (volatility20 > 55) {
    score -= 8; riskScore -= 8; risks.push(`年化波动率约${fixed(volatility20)}%，波动较大`);
  } else if (volatility20 < 30) {
    score += 3; riskScore += 3; reasons.push("近20日波动相对可控");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score_date: latest.time,
    total_score: score,
    signal: score >= 70 ? "强势观察" : score < 40 ? "风险观察" : "中性观察",
    trend_score: trendScore,
    momentum_score: momentumScore,
    volume_score: volumeScore,
    risk_score: riskScore,
    metrics: { close: latest.close, dayChange, ma5, ma10, ma20, ma60, rsi14, return5, return20, volumeRatio, volatility20, distanceFromHigh20 },
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 5),
    bars,
  };
}

async function yahoo(symbol: string, range = "6mo") {
  const payload = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div%2Csplits`);
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "Yahoo无行情");
  const quote = result.indicators?.quote?.[0] || {};
  const bars = (result.timestamp || []).map((timestamp: number, index: number) => ({
    time: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number.isFinite(Number(quote.volume?.[index])) ? Math.trunc(Number(quote.volume[index])) : 0,
  })).filter((row: any) => [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.close > 0);
  if (!bars.length) throw new Error("Yahoo无可用K线");
  return bars;
}

async function eastmoneyKlines(code: string, range = "6mo") {
  const limit = range === "1y" ? 300 : 180;
  const params = new URLSearchParams({
    secid: secid(code),
    klt: "101",
    fqt: "1",
    lmt: String(limit),
    end: "20500101",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56",
  });
  const payload = await getJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const bars = (payload?.data?.klines || []).map((line: string) => {
    const [time, open, close, high, low, volume] = line.split(",");
    return { time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Math.trunc(Number(volume) || 0) };
  }).filter((row: any) => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.close > 0);
  if (!bars.length) throw new Error("东方财富无可用K线");
  return bars;
}

async function history(stock: any, range = "6mo") {
  try {
    return { bars: await yahoo(stock.quote_symbol, range), source: "yahoo" };
  } catch (yahooError) {
    try {
      return { bars: await eastmoneyKlines(stock.code, range), source: "eastmoney", fallback_reason: yahooError instanceof Error ? yahooError.message : "Yahoo失败" };
    } catch (eastmoneyError) {
      const first = yahooError instanceof Error ? yahooError.message : "Yahoo失败";
      const second = eastmoneyError instanceof Error ? eastmoneyError.message : "东方财富失败";
      throw new Error(`Yahoo：${first}；东方财富：${second}`);
    }
  }
}

const marketFilter = "m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:3+f:!2";
async function universePage(page: number) {
  const params = new URLSearchParams({
    pn: String(page), pz: "100", po: "1", np: "1", fltt: "2", invt: "2", fid: "f12",
    fs: marketFilter, fields: "f12,f14,f13,f100",
  });
  const payload = await getJson(`https://push2.eastmoney.com/api/qt/clist/get?${params}`);
  return { total: Number(payload?.data?.total || 0), rows: Array.isArray(payload?.data?.diff) ? payload.data.diff : Object.values(payload?.data?.diff || {}) };
}

async function importUniverse(userId: string) {
  const first = await universePage(1);
  if (!first.rows.length) throw new Error("A股名单源暂时没有返回数据");
  const pageCount = Math.min(70, Math.ceil(first.total / 100));
  const pages: any[][] = [first.rows];
  for (let start = 2; start <= pageCount; start += 6) {
    const pageNumbers = Array.from({ length: Math.min(6, pageCount - start + 1) }, (_, index) => start + index);
    const group = await Promise.all(pageNumbers.map((page) => universePage(page)));
    pages.push(...group.map((item) => item.rows));
  }
  const unique = new Map<string, any>();
  pages.flat().forEach((row: any) => {
    const code = String(row.f12 || "").padStart(6, "0");
    if (!/^\d{6}$/.test(code)) return;
    unique.set(code, {
      user_id: userId,
      code,
      name: String(row.f14 || code),
      industry: row.f100 && row.f100 !== "-" ? String(row.f100) : "",
      market: market(code),
      exchange: exchange(code),
      currency: "CNY",
      quote_symbol: quoteSymbol(code),
      enabled: true,
      source: "eastmoney+yahoo",
      updated_at: new Date().toISOString(),
    });
  });
  const rows = [...unique.values()];
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await db.from("quant_stocks").upsert(rows.slice(index, index + 500), { onConflict: "user_id,quote_symbol" });
    if (error) throw error;
  }
  console.log("[quant-engine] universe imported", { user_id: userId, reported_total: first.total, imported: rows.length, pages: pageCount });
  return { reported_total: first.total, imported: rows.length, pages: pageCount };
}

async function processStock(userId: string, stock: any) {
  try {
    const data = await history(stock);
    const analysis = analyze(data.bars);
    const prices = analysis.bars.map((row: any) => ({
      quote_symbol: stock.quote_symbol,
      price_date: row.time,
      interval: "1d",
      source: data.source,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      fetched_at: new Date().toISOString(),
    }));
    const { error: priceError } = await db.from("market_prices").upsert(prices, { onConflict: "quote_symbol,price_date,interval,source" });
    if (priceError) throw priceError;
    const score = {
      user_id: userId,
      stock_id: stock.id,
      score_date: analysis.score_date,
      total_score: analysis.total_score,
      signal: analysis.signal,
      trend_score: analysis.trend_score,
      momentum_score: analysis.momentum_score,
      volume_score: analysis.volume_score,
      risk_score: analysis.risk_score,
      metrics: { ...analysis.metrics, dataSource: data.source },
      reasons: analysis.reasons,
      risks: analysis.risks,
    };
    const { error: scoreError } = await db.from("quant_scores").upsert(score, { onConflict: "user_id,stock_id,score_date" });
    if (scoreError) throw scoreError;
    const { error: stockError } = await db.from("quant_stocks").update({
      current_price: analysis.metrics.close,
      price_date: analysis.score_date,
      last_scanned_at: new Date().toISOString(),
      scan_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", stock.id).eq("user_id", userId);
    if (stockError) throw stockError;
    return { ok: true, code: stock.code, name: stock.name, source: data.source, score: analysis.total_score };
  } catch (error) {
    const message = error instanceof Error ? error.message : "扫描失败";
    await db.from("quant_stocks").update({ scan_error: message, last_scanned_at: new Date().toISOString() }).eq("id", stock.id).eq("user_id", userId);
    return { ok: false, code: stock.code, name: stock.name, error: message };
  }
}

async function scanBatch(userId: string, offset: number, limit: number) {
  const { data: stocks, error } = await db.from("quant_stocks").select("*").eq("user_id", userId).eq("enabled", true).order("code").range(offset, offset + limit - 1);
  if (error) throw error;
  console.log("[quant-engine] scan started", { user_id: userId, offset, requested: limit, found: stocks?.length || 0 });
  const completed: any[] = [];
  for (let index = 0; index < (stocks || []).length; index += 4) {
    completed.push(...await Promise.all((stocks || []).slice(index, index + 4).map((stock) => processStock(userId, stock))));
  }
  const results = completed.filter((item) => item.ok);
  const failures = completed.filter((item) => !item.ok);
  console.log("[quant-engine] scan finished", { user_id: userId, offset, success: results.length, failed: failures.length });
  return { offset, processed: (stocks || []).length, success: results.length, failed: failures.length, next_offset: offset + (stocks || []).length, results, failures };
}

async function chart(userId: string, stockId: string) {
  const { data: stock, error } = await db.from("quant_stocks").select("*").eq("id", stockId).eq("user_id", userId).single();
  if (error || !stock) throw new Error("股票不存在");
  const data = await history(stock, "1y");
  return { stock, bars: data.bars, source: data.source };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userId = await currentUserId(req);
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "status";
    if (action === "import_universe") return output(await importUniverse(userId));
    if (action === "scan_batch") {
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 10)));
      return output(await scanBatch(userId, offset, limit));
    }
    if (action === "chart") return output(await chart(userId, String(url.searchParams.get("stock_id") || "")));
    return output({ ok: true });
  } catch (error) {
    console.error("[quant-engine] request failed", error);
    return output({ error: error instanceof Error ? error.message : "量化服务失败" }, 400);
  }
});
