"""Бот-уведомления о цене крипты для Telegram.

Запускается по расписанию в GitHub Actions. Читает правила из config.json,
смотрит текущие цены и пишет в Telegram, если правило сработало.
Чтобы не спамить, каждое правило срабатывает один раз, пока цена не вернётся
обратно. Что уже сработало, хранится в state.json.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

CONFIG_FILE = "config.json"
STATE_FILE = "state.json"


def fetch_price(coin):
    """Цена одной монеты в долларах (публичный API Coinbase, ключ не нужен)."""
    url = "https://api.coinbase.com/v2/prices/%s-USD/spot" % coin
    with urllib.request.urlopen(url, timeout=20) as r:
        return float(json.load(r)["data"]["amount"])


def send_message(token, chat_id, text):
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=20) as r:
        r.read()


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def rule_key(rule):
    return "%s:%s:%s" % (rule["coin"], rule["when"], rule["price"])


def is_hit(rule, price):
    if rule["when"] == "above":
        return price >= rule["price"]
    if rule["when"] == "below":
        return price <= rule["price"]
    raise ValueError('when должно быть "above" или "below": %r' % rule)


def run(config, state, get_price, send):
    """Возвращает новое состояние. get_price и send подставляются снаружи."""
    prices = {}
    for rule in config["alerts"]:
        coin = rule["coin"]
        if coin not in prices:
            prices[coin] = get_price(coin)

    new_state = dict(state)
    for rule in config["alerts"]:
        key = rule_key(rule)
        price = prices[rule["coin"]]
        hit = is_hit(rule, price)
        if hit and not state.get(key):
            word = "выше" if rule["when"] == "above" else "ниже"
            send("%s сейчас $%s, это %s твоего уровня $%s." % (
                rule["coin"], format(price, ",.2f"), word, format(rule["price"], ",.2f")))
            new_state[key] = True
        elif not hit and state.get(key):
            new_state[key] = False  # цена вернулась, правило снова активно
    return new_state


def main():
    config = load_json(CONFIG_FILE, {"alerts": []})
    state = load_json(STATE_FILE, {})
    token = os.environ.get("TELEGRAM_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        sys.exit("Нет TELEGRAM_TOKEN или TELEGRAM_CHAT_ID. Добавь их в Secrets репозитория.")

    new_state = run(config, state, fetch_price, lambda t: send_message(token, chat_id, t))
    if new_state != state:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(new_state, f, indent=2, ensure_ascii=False)
        print("Состояние обновлено.")
    else:
        print("Ничего не изменилось.")


if __name__ == "__main__":
  main()
