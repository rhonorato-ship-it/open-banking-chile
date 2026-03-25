#!/bin/sh
set -e

SCHEDULE="${CRON_SCHEDULE:-0 7 * * *}"

echo "Iniciando open-banking-chile con schedule: $SCHEDULE"

# Write crontab
echo "$SCHEDULE /usr/local/bin/node /app/dist/cli.js --all --sync-drive >> /var/log/sync.log 2>&1" > /etc/crontabs/root
echo "" >> /etc/crontabs/root

# Run once immediately on startup (optional, remove if not desired)
echo "Ejecutando sincronización inicial..."
/usr/local/bin/node /app/dist/cli.js --all --sync-drive || true

echo "Iniciando cron daemon (schedule: $SCHEDULE)"
exec crond -f -l 2
