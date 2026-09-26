#!/usr/bin/env sh
# Notification hook for opera-guest-emails -> Telegram.
#
# Wire it up in config.json:
#   "notify": { "command": "/opt/opera-guest-emails/scripts/notify-telegram.sh" }
# and provide the bot credentials via the environment (systemd EnvironmentFile,
# or export them in the cron line). Never put them in config.json or git.
#   TELEGRAM_BOT_TOKEN=123456:ABC...   (from @BotFather)
#   TELEGRAM_CHAT_ID=-100123456789     (your chat / group id)
#
# The tool passes: NOTIFY_EVENT (session_expired | run_failed | export_not_found
# | run_succeeded), NOTIFY_MESSAGE (human text) and NOTIFY_JSON (full payload).
set -eu

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "notify-telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping" >&2
  exit 0
fi

case "${NOTIFY_EVENT:-}" in
  session_expired) icon="🔐" ;;
  run_succeeded)   icon="✅" ;;
  *)               icon="⚠️" ;;
esac

curl -fsS --max-time 15 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${icon} OPERA guest emails [${NOTIFY_EVENT:-event}] ${NOTIFY_MESSAGE:-}" \
  >/dev/null
