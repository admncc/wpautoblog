# Installation auf einem Server

Alles hier ist zum Kopieren ins Terminal gedacht. Getestet mit Ubuntu 22.04/24.04
und Debian 12; auf anderen Systemen unterscheiden sich nur die Paketbefehle.

**Was du brauchst**
- Einen Server mit Root-Zugang (1 GB RAM reicht)
- Eine Domain oder Subdomain, deren A-Record auf die IP des Servers zeigt (z. B. `autoblog.deinedomain.de`)
- Einen Anthropic API-Key von [console.anthropic.com](https://console.anthropic.com/settings/keys)

---

## 1. Auf den Server verbinden

```bash
ssh root@DEINE-SERVER-IP
```

## 2. Docker installieren

Prüfen, ob Docker schon da ist:

```bash
docker --version
```

Falls nicht:

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Projekt holen

```bash
apt update && apt install -y git
git clone https://github.com/admncc/wpautoblog.git /opt/wpautoblog
cd /opt/wpautoblog
```

## 4. Konfiguration anlegen

```bash
cat > .env <<'ENV'
PUBLIC_URL=https://autoblog.deinedomain.de
ENV
```

`PUBLIC_URL` ist die Adresse, unter der der Hub später erreichbar ist – genau diese
Adresse trägst du später im WordPress-Plugin ein. Den API-Key musst du hier nicht
eintragen, er lässt sich bequemer in der Oberfläche hinterlegen.

## 5. Starten

```bash
docker compose up -d --build
```

Der erste Build dauert ein bis zwei Minuten. Danach prüfen:

```bash
docker compose ps
curl http://127.0.0.1:4000/health
```

Erwartete Antwort: `{"ok":true,"version":"1.0.0"}`

Der Hub lauscht bewusst nur auf `127.0.0.1` – aus dem Internet ist er erst über den
Reverse Proxy im nächsten Schritt erreichbar.

## 5b. Update-Helfer einrichten (einmalig)

Damit sich der Hub später per Knopfdruck selbst aktualisieren kann:

```bash
cd /opt/wpautoblog
sudo ./ops/install-updater.sh
docker compose up -d
```

Das richtet einen kleinen Dienst auf dem Server ein, der auf Anforderungen des Hubs wartet.
Der Hub selbst bekommt dabei **keinen** Zugriff auf Docker oder den Server: Er legt lediglich
eine Datei im Ordner `ops/control` ab, den Rest erledigt der Helfer.

Prüfen:

```bash
systemctl status autoblog-updater
```

Ab jetzt steht unten links in der Oberfläche die laufende Version mit Aufspieldatum,
und der Knopf **System-Update** holt den neuesten Stand aus dem Repository und startet den Hub neu.

## 6. HTTPS einrichten (Caddy)

Caddy holt das Zertifikat automatisch von Let's Encrypt.

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Konfiguration schreiben (Domain anpassen):

```bash
cat > /etc/caddy/Caddyfile <<'CADDY'
autoblog.deinedomain.de {
    reverse_proxy 127.0.0.1:4000
}
CADDY

systemctl reload caddy
```

Firewall öffnen, falls `ufw` aktiv ist:

```bash
ufw allow 80/tcp && ufw allow 443/tcp
```

Jetzt im Browser `https://autoblog.deinedomain.de` aufrufen.

> **Kein Domainname zur Hand?** Zum Ausprobieren geht auch ohne Proxy:
> `BIND_ADDR=0.0.0.0 PUBLIC_URL=http://DEINE-IP:4000 docker compose up -d`
> Das ist unverschlüsselt – nur zum Testen, nicht für den Dauerbetrieb.

## 7. Ersteinrichtung im Browser

1. Konto anlegen (E-Mail + Passwort, mindestens 8 Zeichen). Das geht nur einmal.
2. **Einstellungen** → Anthropic API-Key eintragen → Speichern.
3. **Websites → Neue Website anlegen** → Name eingeben.

Die Website zeigt dir jetzt im Reiter **Verbindung** die Hub-Adresse und den Website-Token.

---

## 8. Das WordPress-Plugin installieren

ZIP-Archiv auf dem Server erzeugen:

```bash
cd /opt/wpautoblog
./build-plugin-zip.sh
```

Auf den eigenen Rechner herunterladen (**neues Terminalfenster**, lokal ausführen):

```bash
scp root@DEINE-SERVER-IP:/opt/wpautoblog/autoblog-connector.zip ~/Downloads/
```

Dann in WordPress: **Plugins → Installieren → Plugin hochladen** → ZIP auswählen →
installieren → aktivieren.

*Falls du ohnehin SSH-Zugang zum WordPress-Server hast, geht es auch direkt:*

```bash
scp autoblog-connector.zip user@wordpress-server:/tmp/
ssh user@wordpress-server
cd /pfad/zu/wordpress/wp-content/plugins && unzip /tmp/autoblog-connector.zip
```

Danach in WordPress unter „Plugins" aktivieren.

## 9. Verbinden

1. In WordPress: **Einstellungen → Autoblog**
2. **Hub-Adresse** eintragen: `https://autoblog.deinedomain.de`
3. **Website-Token** aus dem Hub einfügen (beginnt mit `wpab_`)
4. Auf **Verbinden** klicken
5. Zurück im Hub: **Verbindung testen** – dort sollte „Verbunden mit WordPress …" stehen

Für jede weitere WordPress-Seite: im Hub eine neue Website anlegen (eigener Token),
dasselbe ZIP dort installieren, den neuen Token eintragen.

---

## Betrieb

**Läuft alles?**

```bash
cd /opt/wpautoblog
docker compose ps
docker compose logs -f --tail 50      # mit Strg+C beenden
```

**Neustart**

```bash
docker compose restart
```

**Update auf eine neue Version**

Am einfachsten über den Knopf **System-Update** unten links in der Oberfläche.
Er zieht den neuesten Stand aus dem Repository, baut das Image neu und startet den Hub.
Von Hand geht es genauso:

```bash
cd /opt/wpautoblog
git pull
docker compose up -d --build
```

Die Daten überleben das Update, sie liegen im Docker-Volume `autoblog-data`, nicht im Container.
Bricht ein Update ab, weil auf dem Server Dateien verändert wurden, meldet der Hub das
im Klartext und lässt den alten Stand unangetastet. Nachsehen mit `git status` im Repository.

**Sicherung**

```bash
docker run --rm -v autoblog-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/autoblog-backup-$(date +%F).tar.gz -C /data .
```

Darin sind Datenbank *und* der Schlüssel `.app_secret`, mit dem API-Key und Token
verschlüsselt sind. Die Sicherung entsprechend vertraulich behandeln.

**Zurückspielen**

```bash
docker compose down
docker run --rm -v autoblog-data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/autoblog-backup-2026-01-01.tar.gz -C /data
docker compose up -d
```

**Passwort vergessen**

```bash
docker compose exec hub node scripts/reset-password.js deine@mail.de neuesPasswort
```

---

## Wenn etwas klemmt

| Problem | Prüfen |
|---|---|
| Seite lädt nicht | `docker compose ps` – läuft der Container? `docker compose logs --tail 50` |
| Zertifikatsfehler | Zeigt der A-Record der Domain wirklich auf diesen Server? `systemctl status caddy` |
| „Token unbekannt" | Token im Hub erneut kopieren – er wurde eventuell neu erzeugt |
| „WordPress nicht erreichbar" | Ist die WordPress-Seite öffentlich erreichbar? Sonst im Hub auf „WordPress holt selbst ab" umstellen |
| „Zeitstempel abgelaufen" | Uhrzeit der Server vergleichen: `timedatectl` |
| Artikel schlägt fehl | Im Hub unter **Protokoll** die Fehlermeldung lesen – dort steht die Ursache im Klartext |
| „Update-Helfer nicht eingerichtet" | `sudo ./ops/install-updater.sh` ausführen, danach `docker compose up -d` |
| Update bleibt hängen | `journalctl -u autoblog-updater -f` zeigt, woran es liegt |

Mehr dazu in [Diagnose](03-diagnose.md).

---

## Ohne Docker (Alternative)

Falls du Docker nicht einsetzen willst – Node.js 20 oder neuer vorausgesetzt:

```bash
git clone https://github.com/admncc/wpautoblog.git /opt/wpautoblog
cd /opt/wpautoblog/hub
npm install
cp .env.example .env
nano .env                      # PUBLIC_URL eintragen
npm start                      # Test: läuft auf Port 4000
```

Für den Dauerbetrieb als Dienst einrichten:

```bash
cat > /etc/systemd/system/autoblog.service <<'UNIT'
[Unit]
Description=Autoblog Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wpautoblog/hub
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now autoblog
systemctl status autoblog
```

Reverse Proxy (Schritt 6) und alles Weitere bleiben identisch.
