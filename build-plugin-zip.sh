#!/usr/bin/env bash
# Erstellt aus dem Plugin-Ordner ein ZIP-Archiv, das sich in WordPress
# unter "Plugins -> Installieren -> Plugin hochladen" einspielen laesst.
#
#   ./build-plugin-zip.sh            -> autoblog-connector.zip im aktuellen Ordner
#   ./build-plugin-zip.sh /tmp       -> autoblog-connector.zip in /tmp
set -euo pipefail

quelle="$(cd "$(dirname "$0")" && pwd)/wordpress-plugin"
ziel="${1:-$(pwd)}/autoblog-connector.zip"

if [ ! -d "$quelle/autoblog-connector" ]; then
  echo "Plugin-Ordner nicht gefunden: $quelle/autoblog-connector" >&2
  exit 1
fi

if command -v zip >/dev/null 2>&1; then
  rm -f "$ziel"
  (cd "$quelle" && zip -rq "$ziel" autoblog-connector -x '*.DS_Store')
else
  # Fallback ohne das Programm "zip" - Python ist auf Servern fast immer vorhanden.
  python3 - "$quelle" "$ziel" <<'PY'
import os, sys, zipfile
quelle, ziel = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(ziel, 'w', zipfile.ZIP_DEFLATED) as archiv:
    for ordner, _, dateien in os.walk(os.path.join(quelle, 'autoblog-connector')):
        for datei in dateien:
            if datei == '.DS_Store':
                continue
            pfad = os.path.join(ordner, datei)
            archiv.write(pfad, os.path.relpath(pfad, quelle))
PY
fi

echo "Fertig: $ziel"
echo "In WordPress einspielen unter: Plugins -> Installieren -> Plugin hochladen"
