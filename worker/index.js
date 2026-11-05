// Бот цен для Telegram на Cloudflare Workers (бесплатно).
// 1) Каждые 5 секунд смотрит цену и пишет, когда сработал уровень из config.json.
// 2) Показывает кнопки: Цена BTC, Цена ETH, Все цены, Мои уровни.

const INTERVAL_MS = 5000; // как часто проверять цену
const CONFIG_TTL_MS = 60000; // как часто перечитывать config.json
const COINS = ["BTC", "ETH", "SOL"];

const DEFAULT_CONFIG_URL = "https://raw.githubusercontent.com/Whether001/crypto-bot/main/config.json";
const DEFAULT_PRICE_BASE = "https://api.coinbase.com";
const DEFAULT_TG_BASE = "https://api.telegram.org";

const KEYBOARD = {
  keyboard: [
    [{ text: "Цена BTC" }, { text: "Цена ETH" }],
    [{ text: "Все цены" }, { text: "Мои уровни" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const usd = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdShort = (n) => "$" + Number(n).toLocaleString("en-US");

async function getPrice(env, coin) {
  const base = env.PRICE_BASE || DEFAULT_PRICE_BASE;
  const r = await fetch(base + "/v2/prices/" + coin + "-USD/spot");
  if (!r.ok) throw new Error("price " + coin + " " + r.status);
  return Number((await r.json()).data.amount);
}

async function getConfig(env) {
  const r = await fetch(env.CONFIG_URL || DEFAULT_CONFIG_URL);
  if (!r.ok) throw new Error("config " + r.status);
  return await r.json();
}

async function sendMessage(env, chatId, text, withKeyboard) {
  const base = env.TG_BASE || DEFAULT_TG_BASE;
  const body = { chat_id: chatId, text: text };
  if (withKeyboard) body.reply_markup = KEYBOARD;
  const r = await fetch(base + "/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ---------- Правила ----------

export function ruleKey(rule) {
  return rule.coin + ":" + rule.when + ":" + rule.price;
}

export function isHit(rule, price) {
  if (rule.when === "above") return price >= rule.price;
  if (rule.when === "below") return price <= rule.price;
  return false;
}

export function alertText(rule, price) {
  const verb = rule.when === "above" ? "поднялся выше" : "упал ниже";
  return rule.coin + " " + verb + " " + usdShort(rule.price) + ". Сейчас " + usd(price) + ".";
}

// ---------- Следилка за ценой (Durable Object) ----------

export class Watcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cfg = null;
    this.cfgAt = 0;
    this.fired = null;
  }

  // Её вызывает крон раз в минуту, чтобы цепочка проверок точно не оборвалась.
  async fetch() {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 1000);
    }
    return new Response("ok");
  }

  async alarm() {
    try {
      await this.check();
    } catch (e) {
      console.log("check failed: " + String(e));
    }
    await this.state.storage.setAlarm(Date.now() + INTERVAL_MS);
  }

  async check() {
    const now = Date.now();
    if (!this.cfg || now - this.cfgAt > CONFIG_TTL_MS) {
      try {
        this.cfg = await getConfig(this.env);
        this.cfgAt = now;
      } catch (e) {
        this.cfgAt = now - CONFIG_TTL_MS + 10000; // повторим через 10 секунд
        if (!this.cfg) return;
      }
    }
    const alerts = Array.isArray(this.cfg.alerts) ? this.cfg.alerts : [];
    if (!alerts.length) return;

    if (this.fired === null) this.fired = (await this.state.storage.get("fired")) || {};

    const prices = {};
    const coins = Array.from(new Set(alerts.map((a) => a.coin)));
    await Promise.all(
      coins.map(async (c) => {
        try {
          prices[c] = await getPrice(this.env, c);
        } catch (e) {
          // цену не получили: пропускаем эту монету до следующего раза
        }
      })
    );

    let changed = false;
    for (const rule of alerts) {
      const price = prices[rule.coin];
      if (price === undefined) continue;
      const key = ruleKey(rule);
      const hit = isHit(rule, price);
      if (hit && !this.fired[key]) {
        const ok = await sendMessage(this.env, this.env.TELEGRAM_CHAT_ID, alertText(rule, price), false);
        if (ok) {
          this.fired[key] = true;
          changed = true;
        }
      } else if (!hit && this.fired[key]) {
        this.fired[key] = false; // цена вернулась, правило снова активно
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("fired", this.fired);
  }
}

async function ensureWatcher(env) {
  const stub = env.WATCHER.get(env.WATCHER.idFromName("main"));
  await stub.fetch("https://watcher/ensure");
}

// ---------- Меню ----------

async function answer(env, text) {
  const t = text.trim().toLowerCase();
  if (t === "/start" || t === "/menu") return "Привет! Выбери кнопку внизу, и я покажу цену.";
  if (t === "цена btc") return "BTC сейчас " + usd(await getPrice(env, "BTC"));
  if (t === "цена eth") return "ETH сейчас " + usd(await getPrice(env, "ETH"));
  if (t === "все цены") {
    const prices = await Promise.all(COINS.map((c) => getPrice(env, c)));
    return COINS.map((c, i) => c + ": " + usd(prices[i])).join("\n");
  }
  if (t === "мои уровни") {
    const alerts = (await getConfig(env)).alerts || [];
    if (!alerts.length) return "Уровней пока нет.";
    return (
      "Я напишу тебе, когда:\n" +
      alerts
        .map((a) => "• " + a.coin + " " + (a.when === "above" ? "выше " : "ниже ") + usdShort(a.price))
        .join("\n")
    );
  }
  return "Не понял. Нажми одну из кнопок внизу.";
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      await ensureWatcher(env);
      return new Response("Бот работает");
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("ok");
    }

    const msg = update.message;
    if (!msg || !msg.text) return new Response("ok");
    // Отвечаем только тебе, остальных игнорируем.
    if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok");

    let text;
    try {
      text = await answer(env, msg.text);
    } catch (e) {
      text = "Не получилось получить данные. Попробуй ещё раз через минуту.";
    }
    await sendMessage(env, msg.chat.id, text, true);
    return new Response("ok");
  },

  // Раз в минуту проверяем, что следилка запущена.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureWatcher(env));
  },
};
