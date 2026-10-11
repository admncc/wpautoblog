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

# Wo npm liegt. Ein Dienst startet mit einem kargen PATH: Steckt Node in nvm oder
# unter /opt, findet "npm" sich dort nicht - und ein Update, das die
# Abhaengigkeiten nicht nachzieht, startet den Hub ohne sie.
finde_npm() {
  local kandidat
  if command -v npm >/dev/null 2>&1; then command -v npm; return 0; fi
  for kandidat in /usr/local/bin/npm /usr/bin/npm /opt/node*/bin/npm \
                  "$HOME"/.nvm/versions/node/*/bin/npm /root/.nvm/versions/node/*/bin/npm; do
    [ -x "$kandidat" ] && { echo "$kandidat"; return 0; }
  done
  return 1
}

# Die Adresse, unter der der Hub lokal antwortet. Port aus hub/.env, sonst 4000.
hub_port() {
  local port
  port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$REPO/hub/.env" 2>/dev/null | tail -n 1)"
  echo "${port:-4000}"
}

# Wartet, bis der Hub wieder antwortet. Ohne diese Probe gilt ein Update als
# gelungen, sobald der Befehl zum Neustart abgesetzt ist - auch wenn der Dienst
# danach sofort wieder stirbt, etwa weil ein neues Paket fehlt.
antwortet_wieder() {
  local port ende
  port="$(hub_port)"
  ende=$(( $(date +%s) + ${HEALTH_TIMEOUT:-90} ))
  while [ "$(date +%s)" -lt "$ende" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  protokoll "Der Hub antwortet auf http://127.0.0.1:${port}/health nicht."
  return 1
}

# Startet den Hub neu: bevorzugt ueber Docker, sonst ueber systemd.
# Die Ausgabe landet im Protokoll, damit ein fehlgeschlagener Build sichtbar wird.
# Das Zeitlimit verhindert, dass ein haengender Build den Helfer blockiert.
neu_starten() {
  local limit="${BUILD_TIMEOUT:-900}" npm_bin
  if [ -f "$REPO/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    protokoll "Docker-Image bauen und Container ersetzen (Zeitlimit ${limit}s)"
    timeout "$limit" docker compose -f "$REPO/docker-compose.yml" up -d --build 2>&1 | tee -a "$LOGFILE"
    [ "${PIPESTATUS[0]}" -eq 0 ] || return 1
  elif systemctl list-unit-files 2>/dev/null | grep -q '^autoblog\.service'; then
    if ! npm_bin="$(finde_npm)"; then
      protokoll "npm nicht gefunden. Neue Abhaengigkeiten liessen sich nicht nachziehen."
      return 1
    fi
    protokoll "Abhaengigkeiten aktualisieren ($npm_bin) und Dienst neu starten"
    ( cd "$REPO/hub" && timeout "$limit" "$npm_bin" install --omit=dev ) 2>&1 | tee -a "$LOGFILE"
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then
      protokoll "npm install ist fehlgeschlagen. Der Hub wuerde ohne die neuen Pakete starten."
      return 1
    fi
    if ! systemctl restart autoblog 2>&1 | tee -a "$LOGFILE"; then
      protokoll "systemctl restart autoblog ist fehlgeschlagen."
      return 1
    fi
  else
    protokoll "Kein bekannter Startmechanismus gefunden (weder docker-compose.yml noch autoblog.service)"
    return 1
  fi

  # Erst wenn der Hub wieder antwortet, gilt der Neustart als gelungen.
  antwortet_wieder
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
    if neu_starten; then
      abschluss "failed" "Der Neustart ist fehlgeschlagen. Der vorherige Stand laeuft wieder, Einzelheiten im Protokoll."
    else
      abschluss "failed" "Der Neustart ist fehlgeschlagen, und auch der vorherige Stand kam nicht hoch. Bitte auf dem Server nachsehen: systemctl status autoblog"
    fi
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
