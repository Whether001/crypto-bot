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
const MOVE_REARM = 0.8; // скачок снова «включается», когда изменение упало ниже 80% порога
const DEFAULT_TG_BASE = "https://api.telegram.org";

const KEYBOARD = {
  keyboard: [
    [{ text: "Цена BTC" }, { text: "Цена ETH" }],
    [{ text: "Все цены" }, { text: "Мои уровни" }],
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
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0 };
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

// ---------- Следилка и хранилище (Durable Object) ----------

export class Watcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
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

  async handleCallback(cb) {
    await tg(this.env, "answerCallbackQuery", { callback_query_id: cb.id });
    const chat = cb.message && cb.message.chat;
    if (!chat) return;
    const chatId = String(chat.id);
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
      await watcher(env).fetch("https://watcher/ensure");
      return new Response("Бот работает");
    }
    // Принимаем только сообщения, которые пришли от Telegram.
    const expected = await webhookSecret(env.TELEGRAM_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) return new Response("ok");

    const body = await request.text();
    try {
      await watcher(env).fetch("https://watcher/update", { method: "POST", body: body });
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
