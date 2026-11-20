// Бот для управления компьютером из Telegram (Cloudflare Workers, бесплатно).
// Бот отвечает только владельцу. Программа на компьютере сама опрашивает /pc/poll
// и выполняет команды из белого списка: запуск Rust, вход на сервер, блокировка, перезагрузка, выключение.

const TG_BASE = "https://api.telegram.org";
const ONLINE_MS = 45000; // столько после последнего опроса компьютер считается «на связи»
const TTL_MS = 120000; // команда, которую не забрали за 2 минуты, отменяется
const MAX_QUEUE = 3;
const ADDR_RE = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;

const LABEL = {
  rust: "Rust запущен",
  join: "Подключаюсь к серверу",
  lock: "Компьютер заблокирован",
  restart: "Компьютер перезагружается",
  off: "Компьютер выключается",
};

const B = {
  rust: "🎮 Запустить Rust",
  lock: "🔒 Заблокировать",
  restart: "🔄 Перезагрузить",
  off: "⏻ Выключить",
  status: "📡 Статус",
};

const KEYBOARD = {
  keyboard: [[{ text: B.rust }], [{ text: B.lock }, { text: B.restart }], [{ text: B.off }, { text: B.status }]],
  resize_keyboard: true,
  is_persistent: true,
};

const HELP =
  "Я управляю твоим компьютером.\n\n" +
  "Кнопки внизу: запустить Rust, заблокировать, перезагрузить, выключить, статус.\n" +
  "Зайти на сервер Rust: /join 123.45.67.89:28015\n" +
  "Связать с компьютером: /pair (новая строка и ключ: /newkey)\n\n" +
  "Компьютер должен быть включён, а программа запущена. Выключенный компьютер я включить не умею.";

async function tg(env, method, body) {
  try {
    const r = await fetch((env.TG_BASE || TG_BASE) + "/bot" + env.TELEGRAM_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

function say(env, chatId, text, markup) {
  const body = { chat_id: chatId, text: text };
  if (markup) body.reply_markup = markup;
  return tg(env, "sendMessage", body);
}

export async function webhookSecret(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function newKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Pc {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/pc/poll") return this.poll(request);
    if (path === "/update") {
      let update;
      try {
        update = await request.json();
      } catch (e) {
        return new Response("ok");
      }
      const origin = request.headers.get("x-public-url");
      if (origin) await this.state.storage.put("origin", origin);
      try {
        await this.handle(update);
      } catch (e) {
        console.log("update failed: " + String(e));
      }
    }
    return new Response("ok");
  }

  owner() {
    const id = String(this.env.TELEGRAM_CHAT_ID || "");
    return /^\d+$/.test(id) ? id : null;
  }

  async status() {
    const key = await this.state.storage.get("key");
    if (!key) return "Компьютер ещё не связан с ботом. Напиши /pair, там инструкция.";
    const seen = (await this.state.storage.get("seen")) || 0;
    return Date.now() - seen < ONLINE_MS ? "🟢 Компьютер на связи." : "🔴 Компьютер не на связи. Он выключен, спит или программа не запущена.";
  }

  async enqueue(name, arg) {
    const key = await this.state.storage.get("key");
    if (!key) return "Компьютер ещё не связан с ботом. Напиши /pair, там инструкция.";
    const now = Date.now();
    if (now - ((await this.state.storage.get("seen")) || 0) >= ONLINE_MS) {
      return "🔴 Компьютер не на связи, команду не отправил. Проверь, что он включён и программа запущена.";
    }
    const queue = ((await this.state.storage.get("queue")) || []).filter((c) => now - c.at < TTL_MS);
    if (queue.length >= MAX_QUEUE) return "В очереди уже есть команды. Подожди несколько секунд.";
    const seq = ((await this.state.storage.get("seq")) || 0) + 1;
    queue.push({ id: seq, name: name, arg: arg || "", at: now });
    await this.state.storage.put("seq", seq);
    await this.state.storage.put("queue", queue);
    return "Команда отправлена, жду ответ от компьютера.";
  }

  async handle(update) {
    const owner = this.owner();
    if (!owner) return;
    if (update.callback_query) return this.callback(update.callback_query, owner);
    const msg = update.message;
    if (!msg || !msg.text || !msg.chat || msg.chat.type !== "private" || String(msg.chat.id) !== owner) return;
    const text = msg.text.trim();
    const cmd = text.startsWith("/") ? text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase() : "";
    const arg = text.split(/\s+/).slice(1).join(" ");

    if (cmd === "/start" || cmd === "/help" || cmd === "/menu") return say(this.env, owner, HELP + "\n\n" + (await this.status()), KEYBOARD);
    if (cmd === "/pair" || cmd === "/newkey") {
      let key = await this.state.storage.get("key");
      if (!key || cmd === "/newkey") {
        key = newKey();
        await this.state.storage.put("key", key);
        await this.state.storage.put("queue", []);
      }
      const origin = await this.state.storage.get("origin");
      if (!origin) return say(this.env, owner, "Не удалось узнать адрес бота. Напиши /pair ещё раз через минуту.");
      return say(this.env, owner, "Строка для программы на компьютере. Нажми на неё и удерживай, чтобы скопировать, и никому не показывай:\n\n" + origin + " " + key + "\n\nЕсли строка попала не туда, напиши /newkey. Старая перестанет работать.");
    }
    if (cmd === "/join") {
      if (!ADDR_RE.test(arg)) return say(this.env, owner, "Напиши адрес сервера так: /join 123.45.67.89:28015");
      return say(this.env, owner, await this.enqueue("join", arg));
    }
    if (text === B.rust || cmd === "/rust") return say(this.env, owner, await this.enqueue("rust", ""));
    if (text === B.lock || cmd === "/lock") return say(this.env, owner, await this.enqueue("lock", ""));
    if (text === B.status || cmd === "/status") return say(this.env, owner, await this.status());
    if (text === B.restart || text === B.off || cmd === "/restart" || cmd === "/off") {
      const off = text === B.off || cmd === "/off";
      const word = off ? "выключить" : "перезагрузить";
      return say(this.env, owner, "Точно " + word + " компьютер?", {
        inline_keyboard: [[{ text: "Да, " + word, callback_data: (off ? "offyes" : "restartyes") }, { text: "Отмена", callback_data: "no" }]],
      });
    }
    return say(this.env, owner, "Не понял. Нажми кнопку внизу или напиши /help.", KEYBOARD);
  }

  async callback(cb, owner) {
    await tg(this.env, "answerCallbackQuery", { callback_query_id: cb.id });
    if (!cb.message || !cb.message.chat || String(cb.message.chat.id) !== owner) return;
    let text;
    if (cb.data === "no") text = "Отменил.";
    else if (cb.data === "offyes") text = await this.enqueue("off", "");
    else if (cb.data === "restartyes") text = await this.enqueue("restart", "");
    else return;
    await tg(this.env, "editMessageText", { chat_id: owner, message_id: cb.message.message_id, text: text });
  }

  // Сюда приходит программа с компьютера: показывает ключ, сообщает результат прошлой команды, получает следующую.
  async poll(request) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("bad", { status: 400 });
    }
    const key = await this.state.storage.get("key");
    if (!key || !body || !safeEq(body.key, key)) return new Response("no", { status: 401 });
    const now = Date.now();
    await this.state.storage.put("seen", now);
    const owner = this.owner();
    if (owner && body.done && typeof body.done === "object") {
      const label = LABEL[body.done.name];
      if (label) {
        const note = String(body.done.note || "").slice(0, 120);
        await say(this.env, owner, body.done.ok ? "✅ " + label : "⚠️ Не получилось: " + label.toLowerCase() + (note ? " (" + note + ")" : ""));
      }
    }
    const all = (await this.state.storage.get("queue")) || [];
    const queue = all.filter((c) => now - c.at < TTL_MS);
    const next = queue.shift();
    if (next || queue.length !== all.length) await this.state.storage.put("queue", queue);
    return new Response(JSON.stringify({ cmd: next ? { id: next.id, name: next.name, arg: next.arg } : null }), { headers: { "content-type": "application/json" } });
  }
}

function pc(env) {
  return env.PC.get(env.PC.idFromName("main"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/pc/poll") {
      const raw = await request.text();
      if (raw.length > 2000) return new Response("too big", { status: 413 });
      return pc(env).fetch("https://pc/pc/poll", { method: "POST", body: raw });
    }
    if (request.method !== "POST") return new Response("Бот работает");
    // Принимаем только сообщения, которые пришли от Telegram.
    const expected = await webhookSecret(env.TELEGRAM_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) return new Response("ok");
    try {
      await pc(env).fetch("https://pc/update", {
        method: "POST",
        body: await request.text(),
        headers: { "x-public-url": url.origin },
      });
    } catch (e) {
      console.log("forward failed: " + String(e));
    }
    return new Response("ok");
  },
};
