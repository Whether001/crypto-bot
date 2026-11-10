// Общий бот цен для Telegram на Cloudflare Workers (бесплатно).
// У каждого человека свои уровни. Цена проверяется каждые 5 секунд.
// Уровни добавляются обычным сообщением: «BTC выше 85000».

const INTERVAL_MS = 5000; // как часто проверять цену
const SEND_PER_TICK = 25; // сколько уведомлений отправлять за одну проверку
const MAX_ALERTS = 10; // уровней на одного человека
const OWNER_MAX_ALERTS = 30; // уровней у владельца бота
const DEFAULT_MAX_USERS = 50; // сколько людей максимум (можно поменять в MAX_USERS)
const MAX_FAILS = 50; // после стольких неудачных отправок человек удаляется

const COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC", "LINK", "AVAX", "DOT"];
const MENU_COINS = ["BTC", "ETH", "SOL"];

const DEFAULT_PRICE_BASE = "https://api.coinbase.com";
const DEFAULT_STATS_BASE = "https://api.exchange.coinbase.com";
const DEFAULT_CHART_BASE = "https://quickchart.io";
const MOVE_REARM = 0.8; // скачок снова «включается», когда изменение упало ниже 80% порога
const DEFAULT_TG_BASE = "https://api.telegram.org";

const KEYBOARD = {
  keyboard: [
    [{ text: "Цена BTC" }, { text: "Цена ETH" }],
    [{ text: "Все цены" }, { text: "Мои уровни" }],
    [{ text: "График BTC" }, { text: "График ETH" }],
    [{ text: "Добавить уровень" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const HELP =
  "Я слежу за ценой крипты и пишу тебе, когда цена дойдёт до твоего уровня.\n\n" +
  "Как добавить уровень: напиши сообщением, например:\n" +
  "BTC выше 85000\n" +
  "ETH ниже 2000\n\n" +
  "Можно несколько строк сразу и писать 85k или 85 000.\n\n" +
  "Резкие скачки за сутки: напиши, например:\n" +
  "BTC +5%  (вырос на 5% за 24 часа)\n" +
  "ETH -5%  (упал на 5% за 24 часа)\n" +
  "SOL ±7%  (в любую сторону)\n\n" +
  "Графики: кнопки «График BTC» и «График ETH». Для другой монеты и периода напиши, например: график SOL 7д.\n\n" +
  "Кнопки внизу: цена BTC и ETH, все цены, твои уровни. Чтобы удалить уровень, открой «Мои уровни» и нажми «Удалить».\n\n" +
  "Монеты: " + COINS.join(", ") + ". Максимум " + MAX_ALERTS + " уровней на человека.";

const ADD_HELP =
  "Напиши уровень сообщением, например:\nBTC выше 85000\nETH ниже 2000\n\n" +
  "«выше» значит «напиши, когда цена поднимется выше», «ниже» значит «когда упадёт ниже». " +
  "Можно несколько строк сразу.\n\n" +
  "Скачок за сутки: BTC +5% (рост), ETH -5% (падение), SOL ±7% (в обе стороны).";

// ---------- Форматирование ----------

export function usd(n) {
  const d = n >= 1 ? 2 : 4;
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function usdShort(n) {
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 });
}
export const isMove = (a) => a.when === "up" || a.when === "down";
const fmtPct = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
export function describe(a) {
  if (isMove(a)) return a.coin + (a.when === "up" ? " рост " : " падение ") + fmtPct(a.percent) + "% за 24ч";
  return a.coin + " " + (a.when === "above" ? "выше " : "ниже ") + usdShort(a.price);
}
export function alertText(a, price, change) {
  if (isMove(a)) {
    const verb = a.when === "up" ? "вырос на " : "упал на ";
    return a.coin + " " + verb + Math.abs(change).toFixed(1) + "% за 24 часа. Сейчас " + usd(price) + ".";
  }
  const verb = a.when === "above" ? "поднялся выше" : "упал ниже";
  return a.coin + " " + verb + " " + usdShort(a.price) + ". Сейчас " + usd(price) + ".";
}

// ---------- Разбор сообщений ----------

export function isHit(rule, price) {
  if (rule.when === "above") return price >= rule.price;
  if (rule.when === "below") return price <= rule.price;
  return false;
}

export function moveHit(a, change) {
  return a.when === "up" ? change >= a.percent : change <= -a.percent;
}
export function moveRearm(a, change) {
  return a.when === "up" ? change < a.percent * MOVE_REARM : change > -a.percent * MOVE_REARM;
}
export function sameAlert(a, b) {
  if (a.coin !== b.coin || a.when !== b.when) return false;
  return isMove(a) ? a.percent === b.percent : a.price === b.price;
}

export function parseNumber(raw) {
  let s = String(raw).trim().toLowerCase().replace(/[$\s]/g, "");
  let mult = 1;
  if (/[kк]$/.test(s)) {
    mult = 1000;
    s = s.slice(0, -1);
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * mult;
  return n > 0 && n < 1e9 ? n : null;
}

const LINE_RE = /^([a-z]{2,6})\s*(выше|ниже|больше|меньше|above|below|>=|<=|>|<)\s*(.+)$/;
const MOVE_RE = /^([a-z]{2,6})\s*(вырастет на|вырос на|упадёт на|упал на|падение|рост|вырос|упал|±|\+\/-|\+|-|−)\s*([\d.,]+)\s*%$/;
const MOVE_TAIL_RE = /\s*(за\s*(день|сутки|24\s*ч(аса)?)|24h)\s*$/;
const UP_WORDS = ["вырастет на", "вырос на", "вырос", "рост", "+"];

export function parseAlertLines(text) {
  const body = String(text).replace(/^\s*\/add(@\w+)?/i, "");
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
  const items = [];
  const errors = [];
  for (const line of lines) {
    const low = line.toLowerCase().replace(MOVE_TAIL_RE, "");
    const mv = MOVE_RE.exec(low);
    if (mv) {
      const percent = parseNumber(mv[3]);
      if (percent === null || percent < 0.1 || percent > 100) {
        errors.push(line.slice(0, 60));
        continue;
      }
      const coin = mv[1].toUpperCase();
      if (mv[2] === "±" || mv[2] === "+/-") {
        items.push({ coin: coin, when: "up", percent: percent });
        items.push({ coin: coin, when: "down", percent: percent });
      } else {
        items.push({ coin: coin, when: UP_WORDS.includes(mv[2]) ? "up" : "down", percent: percent });
      }
      continue;
    }
    const m = LINE_RE.exec(line.toLowerCase().replace(/^\+\s*/, ""));
    const price = m ? parseNumber(m[3]) : null;
    if (!m || price === null) {
      errors.push(line.slice(0, 60));
      continue;
    }
    const dir = m[2];
    const when = dir === "выше" || dir === "больше" || dir === "above" || dir[0] === ">" ? "above" : "below";
    items.push({ coin: m[1].toUpperCase(), when: when, price: price });
  }
  return { items, errors };
}

// ---------- Сеть ----------

async function getPrice(env, coin) {
  const base = env.PRICE_BASE || DEFAULT_PRICE_BASE;
  const r = await fetch(base + "/v2/prices/" + coin + "-USD/spot");
  if (!r.ok) throw new Error("price " + coin + " " + r.status);
  return Number((await r.json()).data.amount);
}

// Цена и изменение за последние 24 часа (скользящее окно).
async function getStats(env, coin) {
  const base = env.STATS_BASE || DEFAULT_STATS_BASE;
  const r = await fetch(base + "/products/" + coin + "-USD/stats", {
    headers: { "user-agent": "coin-pulse-bot", accept: "application/json" },
  });
  if (!r.ok) throw new Error("stats " + coin + " " + r.status);
  const s = await r.json();
  const open = Number(s.open);
  const last = Number(s.last);
  if (!(open > 0) || !(last > 0)) throw new Error("bad stats " + coin);
  return { price: last, change: ((last - open) / open) * 100 };
}

async function tg(env, method, body) {
  const base = env.TG_BASE || DEFAULT_TG_BASE;
  try {
    const r = await fetch(base + "/bot" + env.TELEGRAM_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let desc = "";
    if (!r.ok) {
      try {
        desc = String((await r.json()).description || "");
      } catch (e) {
        // тела ответа может не быть
      }
    }
    return { ok: r.ok, status: r.status, desc: desc };
  } catch (e) {
    return { ok: false, status: 0, desc: "" };
  }
}

function sendMessage(env, chatId, text, markup) {
  const body = { chat_id: chatId, text: text };
  if (markup) body.reply_markup = markup;
  return tg(env, "sendMessage", body);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Секрет вебхука считается из токена бота, отдельно хранить его не нужно.
export async function webhookSecret(token) {
  return (await sha256Hex(String(token))).slice(0, 48);
}

// ---------- Графики ----------

const RANGES = {
  "24h": { label: "24 часа", short: "24ч", span: 86400, gran: 900 },
  "7d": { label: "7 дней", short: "7д", span: 7 * 86400, gran: 3600 },
  "30d": { label: "30 дней", short: "30д", span: 30 * 86400, gran: 21600 },
  "90d": { label: "90 дней", short: "90д", span: 90 * 86400, gran: 86400 },
};
const RANGE_ALIASES = {
  "24ч": "24h", "24h": "24h", "1д": "24h", "1d": "24h", "сутки": "24h", "день": "24h",
  "7д": "7d", "7d": "7d", "неделя": "7d",
  "30д": "30d", "30d": "30d", "месяц": "30d",
  "90д": "90d", "90d": "90d",
};
const CHART_HELP =
  "Графики: нажми «График BTC» или «График ETH». Для другой монеты и периода напиши, например:\n" +
  "график SOL 7д\n\nПериоды: 24ч, 7д, 30д, 90д.";

export function parseRange(s) {
  return RANGE_ALIASES[String(s).toLowerCase()] || null;
}

// «График BTC», «график sol 7д», «/chart ETH 30d». Если период непонятен, range будет null.
export function parseChartRequest(text) {
  const m = /^(?:\/chart(?:@\w+)?|график)\s+([a-z]{2,6})(?:\s+(\S+))?\s*$/i.exec(String(text).trim());
  if (!m) return null;
  const coin = m[1].toUpperCase();
  if (!m[2]) return { coin: coin, range: "24h" };
  return { coin: coin, range: parseRange(m[2]) };
}

// Свечи Coinbase. Сначала биржевой источник, если он не отвечает, публичный запасной.
const BROKERAGE_GRAN = { 900: "FIFTEEN_MINUTE", 3600: "ONE_HOUR", 21600: "SIX_HOUR", 86400: "ONE_DAY" };

async function candlesExchange(env, coin, r, end) {
  const base = env.STATS_BASE || DEFAULT_STATS_BASE;
  const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url =
    base + "/products/" + coin + "-USD/candles?granularity=" + r.gran + "&start=" + iso(end - r.span) + "&end=" + iso(end);
  const res = await fetch(url, { headers: { "user-agent": "coin-pulse-bot", accept: "application/json" } });
  if (!res.ok) throw new Error("exchange " + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("exchange bad answer");
  // строки: [время, мин, макс, открытие, закрытие, объём]
  return rows.map((c) => ({ t: Number(c[0]) * 1000, p: Number(c[4]) }));
}

async function candlesBrokerage(env, coin, r, end) {
  const base = env.PRICE_BASE || DEFAULT_PRICE_BASE;
  const url =
    base + "/api/v3/brokerage/market/products/" + coin + "-USD/candles?granularity=" + BROKERAGE_GRAN[r.gran] +
    "&start=" + (end - r.span) + "&end=" + end;
  const res = await fetch(url, { headers: { "user-agent": "coin-pulse-bot", accept: "application/json" } });
  if (!res.ok) throw new Error("brokerage " + res.status);
  const j = await res.json();
  if (!j || !Array.isArray(j.candles)) throw new Error("brokerage bad answer");
  return j.candles.map((c) => ({ t: Number(c.start) * 1000, p: Number(c.close) }));
}

export async function getCandles(env, coin, rangeKey) {
  const r = RANGES[rangeKey];
  const end = Math.floor(Date.now() / 1000);
  const errors = [];
  for (const source of [candlesExchange, candlesBrokerage]) {
    try {
      const pts = (await source(env, coin, r, end))
        .filter((x) => x.t > 0 && x.p > 0)
        .sort((a, b) => a.t - b.t);
      if (pts.length >= 2) return pts;
      errors.push("мало точек");
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e));
    }
  }
  throw new Error("candles " + coin + ": " + errors.join("; "));
}

export function chartSummary(coin, rangeKey, pts) {
  const first = pts[0].p;
  const last = pts[pts.length - 1].p;
  let min = Infinity;
  let max = -Infinity;
  for (const x of pts) {
    if (x.p < min) min = x.p;
    if (x.p > max) max = x.p;
  }
  const change = ((last - first) / first) * 100;
  const caption =
    coin + " за " + RANGES[rangeKey].label + ": " + usd(last) + " (" + (change >= 0 ? "+" : "") + change.toFixed(1) + "%)\n" +
    "Мин " + usd(min) + " · Макс " + usd(max);
  return { first: first, last: last, min: min, max: max, change: change, caption: caption };
}

const pad2 = (n) => String(n).padStart(2, "0");
function labelFor(t, rangeKey) {
  const d = new Date(t);
  if (rangeKey === "24h") return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  return pad2(d.getUTCDate()) + "." + pad2(d.getUTCMonth() + 1);
}

// Описание картинки для quickchart.io (Chart.js 4).
export function chartConfig(coin, rangeKey, pts, info) {
  const title =
    coin + " · " + RANGES[rangeKey].label + " · " + usd(info.last) + " (" + (info.change >= 0 ? "+" : "") + info.change.toFixed(1) + "%)";
  const axis = { ticks: { color: "#93a4b3" }, grid: { color: "#2a3945" } };
  return {
    version: "4",
    backgroundColor: "#0f171e",
    width: 800,
    height: 420,
    format: "png",
    chart: {
      type: "line",
      data: {
        labels: pts.map((x) => labelFor(x.t, rangeKey)),
        datasets: [
          {
            data: pts.map((x) => x.p),
            borderColor: "#4fc3bd",
            backgroundColor: "rgba(79,195,189,0.15)",
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          },
        ],
      },
      options: {
        color: "#e6edf2",
        plugins: {
          legend: { display: false },
          title: { display: true, text: title, color: "#e6edf2", font: { size: 18 } },
        },
        scales: {
          x: {
            ticks: { color: "#93a4b3", maxTicksLimit: 7, maxRotation: 0 },
            grid: { color: "#2a3945" },
            title: rangeKey === "24h" ? { display: true, text: "время UTC", color: "#93a4b3" } : { display: false },
          },
          y: axis,
        },
      },
    },
  };
}

async function makeChartImage(env, coin, rangeKey, pts, info) {
  const base = env.CHART_BASE || DEFAULT_CHART_BASE;
  const r = await fetch(base + "/chart/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chartConfig(coin, rangeKey, pts, info)),
  });
  if (!r.ok) throw new Error("chart " + r.status);
  const j = await r.json();
  if (!j || !j.success || !j.url) throw new Error("chart bad answer");
  return j.url;
}

export function chartLink(origin, coin, rangeKey) {
  return origin + "/chart?coin=" + coin + "&range=" + rangeKey;
}

export function chartMarkup(coin, rangeKey, origin) {
  const rows = [
    Object.keys(RANGES).map((k) => ({
      text: (k === rangeKey ? "• " : "") + RANGES[k].short,
      callback_data: "c:" + coin + ":" + k,
    })),
  ];
  if (origin) rows.push([{ text: "Подробный график", url: chartLink(origin, coin, rangeKey) }]);
  return { inline_keyboard: rows };
}

// ---------- Страница с графиком (открывается по ссылке) ----------

const PAGE = String.raw`<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#eef1f4;--surface:#fff;--fg:#14202b;--muted:#566878;--line:#d3dbe2;--accent:#0b6e6e;--up:#17803d;--down:#c0392b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f171e;--surface:#17222b;--fg:#e6edf2;--muted:#93a4b3;--line:#2a3945;--accent:#4fc3bd;--up:#4cc47a;--down:#ff7a6b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
nav{display:flex;flex-wrap:wrap;gap:8px}
nav a{color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:4px;padding:5px 12px;font-size:.9rem}
nav a.on{color:var(--bg);background:var(--accent);border-color:var(--accent);font-weight:600}
nav a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px}
.coin{font-size:1.4rem;font-weight:700}
.price{font:600 2rem/1.1 ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
.chg{font:500 1.05rem ui-monospace,Menlo,monospace}
.up{color:var(--up)}.down{color:var(--down)}
#chart{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px;touch-action:pan-y}
svg{display:block;width:100%}
.line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round}
.area{fill:var(--accent);opacity:.12}
.grid{stroke:var(--line);stroke-width:1}
.lbl{fill:var(--muted);font:11px ui-monospace,Menlo,monospace}
.cross{stroke:var(--muted);stroke-dasharray:3 3}
.dot{fill:var(--accent);stroke:var(--surface);stroke-width:2}
#tip{position:absolute;pointer-events:none;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font-size:.8rem;white-space:nowrap}
#tip b{font-family:ui-monospace,Menlo,monospace}
.foot{color:var(--muted);font-size:.82rem;margin:0;max-width:65ch}
</style></head><body><main>
<nav aria-label="Монета">__COINS__</nav>
<div class="head"><span class="coin">__COIN__</span><span class="price" id="price"></span><span class="chg" id="chg"></span></div>
<nav aria-label="Период">__RANGES__</nav>
<div id="chart"><svg id="svg" role="img" aria-label="График цены __COIN__ за __LABEL__"></svg><div id="tip" hidden></div></div>
<p class="foot">Данные Coinbase, время в часовом поясе твоего устройства. Это не финансовый совет.</p>
</main>
<script>
(function () {
  var D = __DATA__;
  var RANGE = "__RANGE__";
  var svg = document.getElementById("svg");
  var tip = document.getElementById("tip");
  var box = document.getElementById("chart");
  var NS = "http://www.w3.org/2000/svg";
  function fmt(n) {
    var d = n >= 1 ? 2 : 4;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function axisFmt(n) {
    if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
    return fmt(n);
  }
  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function xLabel(t) {
    var d = new Date(t);
    return RANGE === "24h"
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "numeric", month: "short" });
  }
  var first = D[0][1], last = D[D.length - 1][1], ch = ((last - first) / first) * 100;
  document.getElementById("price").textContent = fmt(last);
  var c = document.getElementById("chg");
  c.textContent = (ch >= 0 ? "+" : "") + ch.toFixed(2) + "% за период";
  c.className = "chg " + (ch >= 0 ? "up" : "down");

  var geo = null;
  function draw() {
    var W = Math.max(280, box.clientWidth - 16);
    var H = Math.max(240, Math.min(400, Math.round(W * 0.55)));
    var L = 76, R = 12, T = 12, B = 26;
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < D.length; i++) { if (D[i][1] < lo) lo = D[i][1]; if (D[i][1] > hi) hi = D[i][1]; }
    var padv = (hi - lo) * 0.08 || hi * 0.01;
    lo -= padv; hi += padv;
    var t0 = D[0][0], t1 = D[D.length - 1][0];
    function X(t) { return L + ((t - t0) / (t1 - t0)) * (W - L - R); }
    function Y(p) { return T + (1 - (p - lo) / (hi - lo)) * (H - T - B); }
    geo = { X: X, Y: Y, W: W, H: H, L: L, R: R };
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("height", H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (i = 0; i <= 4; i++) {
      var v = lo + ((hi - lo) * i) / 4, y = Y(v);
      svg.appendChild(el("line", { x1: L, x2: W - R, y1: y, y2: y, "class": "grid" }));
      var tl = el("text", { x: L - 8, y: y + 4, "text-anchor": "end", "class": "lbl" });
      tl.textContent = axisFmt(v);
      svg.appendChild(tl);
    }
    for (i = 0; i <= 4; i++) {
      var tt = t0 + ((t1 - t0) * i) / 4;
      var xl = el("text", { x: X(tt), y: H - 6, "text-anchor": i === 0 ? "start" : (i === 4 ? "end" : "middle"), "class": "lbl" });
      xl.textContent = xLabel(tt);
      svg.appendChild(xl);
    }
    var d = "";
    for (i = 0; i < D.length; i++) d += (i ? "L" : "M") + X(D[i][0]).toFixed(1) + " " + Y(D[i][1]).toFixed(1);
    svg.appendChild(el("path", { d: d + "L" + X(t1).toFixed(1) + " " + (H - B) + "L" + X(t0).toFixed(1) + " " + (H - B) + "Z", "class": "area" }));
    svg.appendChild(el("path", { d: d, "class": "line" }));
  }
  var cross = null, dot = null;
  function hover(ev) {
    var r = svg.getBoundingClientRect();
    var x = ((ev.clientX - r.left) / r.width) * geo.W;
    var best = 0, bd = Infinity, i;
    for (i = 0; i < D.length; i++) { var dd = Math.abs(geo.X(D[i][0]) - x); if (dd < bd) { bd = dd; best = i; } }
    var px = geo.X(D[best][0]), py = geo.Y(D[best][1]);
    if (!cross) {
      cross = el("line", { "class": "cross" });
      dot = el("circle", { r: 4, "class": "dot" });
      svg.appendChild(cross); svg.appendChild(dot);
    }
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    cross.setAttribute("y1", 12); cross.setAttribute("y2", geo.H - 26);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    tip.hidden = false;
    tip.innerHTML = "<b></b><br><span></span>";
    tip.firstChild.textContent = fmt(D[best][1]);
    tip.lastChild.textContent = new Date(D[best][0]).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    var left = (px / geo.W) * r.width + 8 + 8;
    if (left > r.width - 130) left -= 150;
    tip.style.left = left + "px";
    tip.style.top = "16px";
  }
  function leave() {
    tip.hidden = true;
    if (cross) { svg.removeChild(cross); svg.removeChild(dot); cross = null; dot = null; }
  }
  svg.addEventListener("pointermove", hover);
  svg.addEventListener("pointerleave", leave);
  var timer = null;
  window.addEventListener("resize", function () {
    clearTimeout(timer);
    timer = setTimeout(function () { leave(); draw(); }, 100);
  });
  draw();
})();
</script></body></html>`;

function pageNav(items, current, hrefFor) {
  return items
    .map((it) => '<a href="' + hrefFor(it.key) + '"' + (it.key === current ? ' class="on" aria-current="page"' : "") + ">" + it.text + "</a>")
    .join("");
}

export function chartHtml(coin, rangeKey, pts) {
  const data = JSON.stringify(pts.map((x) => [x.t, x.p])).replace(/</g, "\\u003c");
  const info = chartSummary(coin, rangeKey, pts);
  return PAGE.replace("__TITLE__", coin + " " + usd(info.last))
    .replace("__COINS__", pageNav(COINS.map((c) => ({ key: c, text: c })), coin, (c) => "?coin=" + c + "&range=" + rangeKey))
    .replace(
      "__RANGES__",
      pageNav(Object.keys(RANGES).map((k) => ({ key: k, text: RANGES[k].short })), rangeKey, (k) => "?coin=" + coin + "&range=" + k)
    )
    .split("__COIN__").join(coin)
    .replace("__LABEL__", RANGES[rangeKey].label)
    .replace("__RANGE__", rangeKey)
    .replace("__DATA__", () => data);
}

async function chartPageResponse(env, url) {
  const coin = String(url.searchParams.get("coin") || "BTC").toUpperCase();
  const rangeKey = RANGES[url.searchParams.get("range")] ? url.searchParams.get("range") : "24h";
  const text = { "content-type": "text/plain; charset=utf-8" };
  if (!COINS.includes(coin)) return new Response("Такой монеты нет. Доступны: " + COINS.join(", "), { status: 404, headers: text });
  let pts;
  try {
    pts = await getCandles(env, coin, rangeKey);
  } catch (e) {
    return new Response("Не получилось получить данные. Обнови страницу через минуту.", { status: 502, headers: text });
  }
  return new Response(chartHtml(coin, rangeKey, pts), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------- Следилка и хранилище (Durable Object) ----------

export class Watcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.origin = null; // адрес воркера, нужен для ссылки на график
    this.users = null; // { chatId: { alerts: [{id, coin, when, price, fired}], nextId, fails } }
  }

  async load() {
    if (this.users === null) this.users = (await this.state.storage.get("users")) || {};
    return this.users;
  }

  async save() {
    await this.state.storage.put("users", this.users);
  }

  isOwner(chatId) {
    return String(chatId) === String(this.env.TELEGRAM_CHAT_ID);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/update") {
      let update;
      try {
        update = await request.json();
      } catch (e) {
        return new Response("ok");
      }
      const origin = request.headers.get("x-public-url");
      if (origin) this.origin = origin;
      try {
        await this.handleUpdate(update);
      } catch (e) {
        console.log("update failed: " + String(e));
      }
      return new Response("ok");
    }
    // Её вызывает крон раз в минуту, чтобы цепочка проверок точно не оборвалась.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 1000);
    }
    return new Response("ok");
  }

  // ----- проверка цен -----

  async alarm() {
    try {
      await this.check();
    } catch (e) {
      console.log("check failed: " + String(e));
    }
    await this.state.storage.setAlarm(Date.now() + INTERVAL_MS);
  }

  async check() {
    const users = await this.load();
    const entries = [];
    for (const chatId of Object.keys(users)) {
      for (const a of users[chatId].alerts) entries.push({ chatId: chatId, u: users[chatId], a: a });
    }
    if (!entries.length) return;

    const prices = {};
    const stats = {};
    const levelCoins = Array.from(new Set(entries.filter((e) => !isMove(e.a)).map((e) => e.a.coin)));
    const moveCoins = Array.from(new Set(entries.filter((e) => isMove(e.a)).map((e) => e.a.coin)));
    await Promise.all([
      ...levelCoins.map(async (c) => {
        try {
          prices[c] = await getPrice(this.env, c);
        } catch (e) {
          // цену не получили: пропускаем эту монету до следующего раза
        }
      }),
      ...moveCoins.map(async (c) => {
        try {
          stats[c] = await getStats(this.env, c);
        } catch (e) {
          // данных за сутки нет: пропускаем скачки по этой монете
        }
      }),
    ]);

    let changed = false;
    const pending = [];
    for (const e of entries) {
      if (isMove(e.a)) {
        const s = stats[e.a.coin];
        if (!s) continue;
        if (moveHit(e.a, s.change) && !e.a.fired) {
          pending.push({ chatId: e.chatId, u: e.u, a: e.a, price: s.price, change: s.change });
        } else if (e.a.fired && moveRearm(e.a, s.change)) {
          e.a.fired = false;
          changed = true;
        }
        continue;
      }
      const price = prices[e.a.coin];
      if (price === undefined) continue;
      const hit = isHit(e.a, price);
      if (hit && !e.a.fired) pending.push({ chatId: e.chatId, u: e.u, a: e.a, price: price });
      else if (!hit && e.a.fired) {
        e.a.fired = false; // цена вернулась, уровень снова активен
        changed = true;
      }
    }

    await Promise.all(
      pending.slice(0, SEND_PER_TICK).map(async (p) => {
        // пока мы получали цены, человек мог удалить уровень или себя
        if (users[p.chatId] !== p.u || !p.u.alerts.includes(p.a)) return;
        const r = await sendMessage(this.env, p.chatId, alertText(p.a, p.price, p.change));
        if (r.ok) {
          p.a.fired = true;
          if (p.u.fails) p.u.fails = 0;
          changed = true;
        } else if (r.status === 403) {
          delete users[p.chatId]; // человек заблокировал бота
          changed = true;
        } else {
          p.u.fails = (p.u.fails || 0) + 1;
          if (p.u.fails >= MAX_FAILS) delete users[p.chatId];
          changed = true;
        }
      })
    );
    if (changed) await this.save();
  }

  // ----- сообщения людей -----

  async handleUpdate(update) {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const msg = update.message;
    if (!msg || !msg.text || !msg.chat || msg.chat.type !== "private") return;
    const chatId = String(msg.chat.id);

    const users = await this.load();
    if (!users[chatId]) {
      const maxUsers = Number(this.env.MAX_USERS) || DEFAULT_MAX_USERS;
      if (!this.isOwner(chatId) && Object.keys(users).length >= maxUsers) {
        await sendMessage(this.env, chatId, "Бот пока заполнен, новых людей не принимаю. Попробуй позже.");
        return;
      }
      users[chatId] = { alerts: [], nextId: 1 };
      await this.save();
    }

    const cr = parseChartRequest(msg.text);
    if (cr) {
      if (cr.range === null) await sendMessage(this.env, chatId, "Не знаю такой период. Доступны: 24ч, 7д, 30д, 90д.", KEYBOARD);
      else await this.sendChart(chatId, cr.coin, cr.range, null);
      return;
    }

    let reply;
    try {
      reply = await this.answer(chatId, msg.text);
    } catch (e) {
      reply = { text: "Не получилось получить данные. Попробуй ещё раз через минуту." };
    }
    await sendMessage(this.env, chatId, reply.text, reply.markup || KEYBOARD);
  }

  async answer(chatId, text) {
    const t = text.trim();
    const low = t.toLowerCase();
    const cmd = t.startsWith("/") ? t.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase() : "";

    if (cmd === "/start" || cmd === "/help" || cmd === "/menu") return { text: HELP };
    if (low === "цена btc") return { text: "BTC сейчас " + usd(await getPrice(this.env, "BTC")) };
    if (low === "цена eth") return { text: "ETH сейчас " + usd(await getPrice(this.env, "ETH")) };
    if (low === "все цены") {
      const prices = await Promise.all(MENU_COINS.map((c) => getPrice(this.env, c)));
      return { text: MENU_COINS.map((c, i) => c + ": " + usd(prices[i])).join("\n") };
    }
    if (low === "мои уровни" || cmd === "/list") return this.listReply(chatId);
    if (low === "добавить уровень") return { text: ADD_HELP };
    if (low === "график" || cmd === "/chart") return { text: CHART_HELP };
    if (cmd === "/clear") {
      this.users[chatId].alerts = [];
      await this.save();
      return { text: "Все уровни удалены." };
    }
    if (cmd === "/del") {
      const n = parseInt(t.split(/\s+/)[1], 10);
      const alerts = this.users[chatId].alerts;
      if (!(n >= 1 && n <= alerts.length)) return { text: "Напиши номер уровня из списка, например: /del 2" };
      alerts.splice(n - 1, 1);
      await this.save();
      return this.listReply(chatId, "Удалил.\n\n");
    }
    return this.addAlerts(chatId, t);
  }

  listReply(chatId, prefix) {
    const alerts = this.users[chatId].alerts;
    if (!alerts.length) {
      return { text: (prefix || "") + "Уровней пока нет. Напиши, например: BTC выше 85000" };
    }
    const lines = alerts.map((a, i) => i + 1 + ". " + describe(a) + (a.fired ? " (сработал)" : " (жду)"));
    const buttons = alerts.map((a, i) => ({ text: "Удалить " + (i + 1), callback_data: "d:" + a.id }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    return { text: (prefix || "") + "Твои уровни:\n" + lines.join("\n"), markup: { inline_keyboard: rows } };
  }

  async addAlerts(chatId, text) {
    const parsed = parseAlertLines(text);
    if (!parsed.items.length && !parsed.errors.length) return { text: HELP };

    const user = this.users[chatId];
    const limit = this.isOwner(chatId) ? OWNER_MAX_ALERTS : MAX_ALERTS;
    const out = [];

    for (const it of parsed.items) {
      if (!COINS.includes(it.coin)) {
        out.push("• " + it.coin + ": такой монеты нет. Доступны: " + COINS.join(", ") + ".");
        continue;
      }
      if (user.alerts.length >= limit) {
        out.push("• Лимит " + limit + " уровней. Удали ненужные в «Мои уровни».");
        break;
      }
      if (user.alerts.some((a) => sameAlert(a, it))) {
        out.push("• Уже есть: " + describe(it) + ".");
        continue;
      }
      let now = null;
      let change = null;
      try {
        if (isMove(it)) {
          const s = await getStats(this.env, it.coin);
          now = s.price;
          change = s.change;
        } else {
          now = await getPrice(this.env, it.coin);
        }
      } catch (e) {
        // ниже скажем, что данные не получили
      }
      if (now === null) {
        out.push("• " + it.coin + ": не смог получить данные, попробуй позже.");
        continue;
      }
      const rule = isMove(it)
        ? { id: user.nextId++, coin: it.coin, when: it.when, percent: it.percent, fired: false }
        : { id: user.nextId++, coin: it.coin, when: it.when, price: it.price, fired: false };
      user.alerts.push(rule);
      let line = "• Добавил: " + describe(it) + ". Сейчас " + it.coin + " " + usd(now) + ".";
      if (isMove(it)) line += " За 24 часа: " + (change >= 0 ? "+" : "") + change.toFixed(1) + "%.";
      if (isMove(it) ? moveHit(it, change) : isHit(it, now)) line += " Условие уже выполнено, напишу сразу.";
      out.push(line);
    }
    for (const bad of parsed.errors) out.push("• Не понял строку: «" + bad + "».");
    await this.save();
    if (parsed.errors.length) out.push("\nПример: BTC выше 85000");
    return { text: out.join("\n") };
  }

  async sendChart(chatId, coin, rangeKey, messageId) {
    if (!COINS.includes(coin)) {
      await sendMessage(this.env, chatId, coin + ": такой монеты нет. Доступны: " + COINS.join(", ") + ".", KEYBOARD);
      return;
    }
    let pts;
    try {
      pts = await getCandles(this.env, coin, rangeKey);
    } catch (e) {
      await sendMessage(this.env, chatId, "Не получилось получить данные для графика. Попробуй ещё раз через минуту.\n(" + String(e && e.message ? e.message : e).slice(0, 150) + ")", KEYBOARD);
      return;
    }
    const info = chartSummary(coin, rangeKey, pts);
    const markup = chartMarkup(coin, rangeKey, this.origin);
    let url = null;
    try {
      url = await makeChartImage(this.env, coin, rangeKey, pts, info);
    } catch (e) {
      // ниже отправим текст со ссылкой
    }
    if (!url) {
      let text = info.caption;
      if (this.origin) text += "\n\nГрафик: " + chartLink(this.origin, coin, rangeKey);
      await sendMessage(this.env, chatId, text, markup);
      return;
    }
    if (messageId) {
      const r = await tg(this.env, "editMessageMedia", {
        chat_id: chatId,
        message_id: messageId,
        media: { type: "photo", media: url, caption: info.caption },
        reply_markup: markup,
      });
      if (r.ok || r.desc.includes("not modified")) return;
    }
    await tg(this.env, "sendPhoto", { chat_id: chatId, photo: url, caption: info.caption, reply_markup: markup });
  }

  async handleCallback(cb) {
    await tg(this.env, "answerCallbackQuery", { callback_query_id: cb.id });
    const chat = cb.message && cb.message.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const cm = /^c:([A-Z]{2,6}):(24h|7d|30d|90d)$/.exec(cb.data || "");
    if (cm) {
      await this.sendChart(chatId, cm[1], cm[2], cb.message.message_id);
      return;
    }
    const users = await this.load();
    const user = users[chatId];
    const m = /^d:(\d+)$/.exec(cb.data || "");
    if (!user || !m) return;
    const id = Number(m[1]);
    const before = user.alerts.length;
    user.alerts = user.alerts.filter((a) => a.id !== id);
    if (user.alerts.length !== before) await this.save();
    const r = this.listReply(chatId);
    await tg(this.env, "editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: r.text,
      reply_markup: r.markup || { inline_keyboard: [] },
    });
  }
}

// ---------- Вход ----------

function watcher(env) {
  return env.WATCHER.get(env.WATCHER.idFromName("main"));
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      const url = new URL(request.url);
      if (url.pathname === "/chart") return chartPageResponse(env, url);
      await watcher(env).fetch("https://watcher/ensure");
      return new Response("Бот работает");
    }
    // Принимаем только сообщения, которые пришли от Telegram.
    const expected = await webhookSecret(env.TELEGRAM_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) return new Response("ok");

    const body = await request.text();
    try {
      await watcher(env).fetch("https://watcher/update", {
        method: "POST",
        body: body,
        headers: { "x-public-url": new URL(request.url).origin },
      });
    } catch (e) {
      console.log("forward failed: " + String(e));
    }
    return new Response("ok");
  },

  // Раз в минуту проверяем, что следилка запущена.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watcher(env).fetch("https://watcher/ensure"));
  },
};
