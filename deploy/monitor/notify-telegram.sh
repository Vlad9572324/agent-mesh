#!/bin/bash
# agent-link-monitor notify hook: sends one Telegram message per notification.
# Reads the notification JSON from stdin. The bot token and chat id come from a
# 0600 file (default below) and reach curl only through a private config fd,
# never through arguments, environment or output.
#   /etc/agent-mesh-monitor/telegram:   token=<bot token>   chat_id=<id>
set -u
umask 077
cred="${TELEGRAM_CRED_FILE:-/etc/agent-mesh-monitor/telegram}"
[ -f "$cred" ] && [ ! -L "$cred" ] || exit 3
[ "$(stat -c '%a %u' "$cred")" = "600 $(id -u)" ] || exit 3
token="" chat=""
while IFS='=' read -r name value; do
  case "$name" in token) token="$value" ;; chat_id) chat="$value" ;; esac
done < "$cred"
[[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ && "$chat" =~ ^-?[0-9]+$ ]] || exit 3
text="$(python3 -c '
import json, re, sys
n = json.load(sys.stdin)
clean = lambda v: re.sub(r"[^\x20-\x7e]", "?", str(v))[:300]
print("[%s] %s\n%s\nid: %s" % (clean(n.get("severity")), clean(n.get("summary")), "host: " + clean(n.get("host")), clean(n.get("id"))))
')" || exit 4
[ -n "$text" ] || exit 4
exec curl --silent --show-error --fail --max-time 15 --proto '=https' --output /dev/null \
  -K <(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token") \
  --data-urlencode "chat_id=$chat" --data-urlencode "text=$text"
