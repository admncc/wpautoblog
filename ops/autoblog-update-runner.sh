#!/usr/bin/env bash
#
# Update-Helfer fuer den Autoblog Hub.
#
# Laeuft als Dienst auf dem Server, nicht im Container. Er beobachtet den Ordner
# ops/control und fuehrt aus, was der Hub dort anfordert. So kann der Hub sich
# selbst aktualisieren, ohne Zugriff auf Docker oder den Server zu bekommen.
#
# Einrichten mit: sudo ./ops/install-updater.sh
set -uo pipefail

REPO="${REPO:-/opt/wpautoblog}"
CONTROL="$REPO/ops/control"
INTERVAL="${INTERVAL:-20}"        # Sekunden zwischen zwei Durchlaeufen
FETCH_EVERY="${FETCH_EVERY:-15}"  # nur jeder n-te Durchlauf fragt beim Repo nach

mkdir -p "$CONTROL"
cd "$REPO" || { echo "Repository nicht gefunden: $REPO" >&2; exit 1; }

LOGFILE="$CONTROL/last-update.log"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# Schreibt zusaetzlich in die Datei, die der Hub anzeigt.
protokoll() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOGFILE"; }

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || printf '""'; }

# Merkt sich das Ergebnis des letzten Updates, damit es im Hub sichtbar bleibt.
LETZTER_STATUS="idle"
LETZTER_FEHLER=""
FINISHED_AT=""

schreibe_state() {
  local status="$1" fehler="${2:-}"
  local lokal fern hinterher branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  lokal="$(git rev-parse HEAD 2>/dev/null || echo '')"
  fern="$(git rev-parse "origin/$branch" 2>/dev/null || echo '')"
  hinterher="$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)"

  cat > "$CONTROL/state.json.tmp" <<JSON
{
  "checked_at": "$(date -u +%FT%TZ)",
  "branch": "$branch",
  "local_commit": "$lokal",
  "remote_commit": "$fern",
  "behind": ${hinterher:-0},
  "update_available": $([ "${hinterher:-0}" -gt 0 ] && echo true || echo false),
  "status": "$status",
  "error": $(printf '%s' "$fehler" | json_escape),
  "finished_at": "${FINISHED_AT:-}"
}
JSON
  mv "$CONTROL/state.json.tmp" "$CONTROL/state.json"
}

schreibe_version() {
  cat > "$CONTROL/version.json.tmp" <<JSON
{
  "commit": "$(git rev-parse HEAD)",
  "message": $(git log -1 --pretty=%s | json_escape),
  "committed_at": "$(git log -1 --date=iso-strict --pretty=%cd)",
  "deployed_at": "$(date -u +%FT%TZ)",
  "branch": "$(git rev-parse --abbrev-ref HEAD)"
}
JSON
  mv "$CONTROL/version.json.tmp" "$CONTROL/version.json"
}

# Startet den Hub neu: bevorzugt ueber Docker, sonst ueber systemd.
# Die Ausgabe landet im Protokoll, damit ein fehlgeschlagener Build sichtbar wird.
# Das Zeitlimit verhindert, dass ein haengender Build den Helfer blockiert.
neu_starten() {
  local limit="${BUILD_TIMEOUT:-900}"
  if [ -f "$REPO/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    protokoll "Docker-Image bauen und Container ersetzen (Zeitlimit ${limit}s)"
    timeout "$limit" docker compose -f "$REPO/docker-compose.yml" up -d --build 2>&1 | tee -a "$LOGFILE"
    return "${PIPESTATUS[0]}"
  elif systemctl list-unit-files 2>/dev/null | grep -q '^autoblog\.service'; then
    protokoll "Abhaengigkeiten aktualisieren und Dienst neu starten"
    ( cd "$REPO/hub" && timeout "$limit" npm install --omit=dev ) 2>&1 | tee -a "$LOGFILE"
    systemctl restart autoblog 2>&1 | tee -a "$LOGFILE"
    return 0
  fi
  protokoll "Kein bekannter Startmechanismus gefunden (weder docker-compose.yml noch autoblog.service)"
  return 1
}

# Merkt Ergebnis und Zeitpunkt und schreibt den Stand fuer den Hub.
abschluss() {
  LETZTER_STATUS="$1"
  LETZTER_FEHLER="${2:-}"
  FINISHED_AT="$(date -u +%FT%TZ)"
  schreibe_state "$LETZTER_STATUS" "$LETZTER_FEHLER"
}

fuehre_update_aus() {
  local branch vorher
  branch="$(git rev-parse --abbrev-ref HEAD)"
  vorher="$(git rev-parse HEAD)"
  LETZTER_STATUS="running"
  LETZTER_FEHLER=""
  FINISHED_AT=""
  schreibe_state "running"
  : > "$LOGFILE"   # Protokoll des vorherigen Laufs verwerfen
  protokoll "Update gestartet (Branch $branch, Stand ${vorher:0:7})"

  if ! timeout 120 git fetch origin "$branch" 2>&1 | tee -a "$LOGFILE"; then
    abschluss "failed" "Repository nicht erreichbar (git fetch)"
    return 1
  fi

  # Nur vorwaerts, damit lokale Aenderungen niemals still ueberschrieben werden.
  if ! git merge --ff-only "origin/$branch" 2>&1 | tee -a "$LOGFILE"; then
    abschluss "failed" "Lokale Aenderungen im Repository verhindern das Update. Auf dem Server pruefen: git status"
    return 1
  fi

  if [ "$(git rev-parse HEAD)" = "$vorher" ]; then
    protokoll "Bereits auf dem neuesten Stand, kein Neustart noetig"
    abschluss "aktuell"
    return 0
  fi

  if ! neu_starten; then
    protokoll "Neustart fehlgeschlagen, alter Stand wird wiederhergestellt"
    git reset --hard "$vorher" 2>&1 | tee -a "$LOGFILE"
    neu_starten
    abschluss "failed" "Der Neustart ist fehlgeschlagen. Der vorherige Stand laeuft weiter, Einzelheiten im Protokoll."
    return 1
  fi

  schreibe_version
  abschluss "success"
  protokoll "Update abgeschlossen: $(git rev-parse --short HEAD)"
}

log "Update-Helfer gestartet fuer $REPO"
[ -f "$CONTROL/version.json" ] || schreibe_version
zaehler=0

while true; do
  if [ -f "$CONTROL/update-request" ]; then
    rm -f "$CONTROL/update-request"
    fuehre_update_aus
    zaehler=0
  elif [ "$zaehler" -le 0 ]; then
    git fetch --quiet origin "$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null
    schreibe_state "$LETZTER_STATUS" "$LETZTER_FEHLER"
    zaehler=$FETCH_EVERY
  else
    # Zwischendurch nur das Lebenszeichen auffrischen, ohne das Repo zu fragen.
    schreibe_state "$LETZTER_STATUS" "$LETZTER_FEHLER"
  fi
  zaehler=$((zaehler - 1))
  sleep "$INTERVAL"
done
