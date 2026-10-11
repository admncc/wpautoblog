#!/usr/bin/env bash
#
# Richtet den Update-Helfer als Dienst ein. Einmalig als root ausfuehren:
#   sudo ./ops/install-updater.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausfuehren: sudo $0" >&2
  exit 1
fi

mkdir -p "$REPO/ops/control"
chmod +x "$REPO/ops/autoblog-update-runner.sh"

cat > /etc/systemd/system/autoblog-updater.service <<UNIT
[Unit]
Description=Autoblog Update-Helfer
After=network-online.target docker.service

[Service]
Type=simple
# Ein Dienst startet mit einem kargen PATH. Steckt Node in /usr/local oder /opt,
# faende der Helfer sonst kein npm - und ein Update zoege neue Abhaengigkeiten
# nicht nach.
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
Environment=REPO=$REPO
ExecStart=$REPO/ops/autoblog-update-runner.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now autoblog-updater

echo
echo "Fertig. Der Update-Helfer laeuft."
echo "Status ansehen:   systemctl status autoblog-updater"
echo "Protokoll:        journalctl -u autoblog-updater -f"
echo
echo "Damit der Hub den Helfer erreicht, muss der Ordner ops/control in den Container"
echo "eingebunden sein. Das ist in docker-compose.yml bereits vorgesehen, danach einmal:"
echo "  cd $REPO && docker compose up -d"
