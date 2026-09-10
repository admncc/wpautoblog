# Architektur

Für alle, die wissen wollen (oder müssen), was unter der Haube passiert.

## Überblick

```
Browser ──► Hub (Node.js/Express) ──► Anthropic API (Claude)
                   │
                   ├── SQLite-Datei (Websites, Themen, Pläne, Artikel, Protokoll)
                   │
                   └──► WordPress-Plugin (REST + HMAC) ──► wp_insert_post()
```

Der Hub braucht keine externe Datenbank und keinen Message-Broker. Alles liegt in
`data/autoblog.sqlite`; für ein Backup genügt es, den Ordner `data/` zu sichern.

## Sicherheitsmodell

**Anmeldung am Hub:** E-Mail und Passwort (bcrypt), Sitzung als signiertes HttpOnly-Cookie.

**Verbindung zu WordPress:** Jede Website hat genau einen Token (`wpab_…`, 24 zufällige Bytes).
Der Token wird im Hub verschlüsselt gespeichert (AES-256-GCM, Schlüssel aus `APP_SECRET`)
und im WordPress-Plugin in den Optionen abgelegt.

Der Token wird bei Übertragungen **nicht mitgeschickt**. Stattdessen signiert die sendende Seite:

```
Signatur = HMAC-SHA256(Token, "<Zeitstempel>\n<Rumpf der Anfrage>")
```

Übertragen werden drei Header:

| Header | Inhalt |
|---|---|
| `X-WPAB-Site` | ID der Website im Hub |
| `X-WPAB-Timestamp` | Unix-Zeit, darf maximal 300 Sekunden abweichen |
| `X-WPAB-Signature` | die Signatur |

Beide Seiten prüfen identisch und vergleichen zeitkonstant. Der Zeitstempel verhindert,
dass eine mitgeschnittene Anfrage später wiederholt werden kann.

**Artikel-HTML** wird zweimal gefiltert: im Hub gegen eine Positivliste erlaubter Tags
(`src/sanitize.js`) und in WordPress noch einmal durch `wp_kses_post()`. Der Filter im Hub
zerlegt den Text in Tags und Freitext und baut ihn aus den Bestandteilen neu auf, statt
Verbotenes herauszuschneiden. Unbekannte Schreibweisen können dadurch nicht durchrutschen.
Adressen in `href` und `src` werden vor der Prüfung von HTML-Entities und Steuerzeichen
befreit, damit eine maskierte `javascript:`-Adresse nicht als harmlos durchgeht.

**Anmeldung:** Nach fünf Fehlversuchen je IP und E-Mail wird gesperrt, die Sperre verdoppelt
sich mit jedem weiteren Versuch bis auf eine Stunde (`src/guard.js`).

**Sicherheitskopfzeilen:** Content-Security-Policy ohne fremde Skriptquellen, dazu
`X-Frame-Options`, `X-Content-Type-Options` und `Referrer-Policy`.

## Datenmodell (SQLite)

| Tabelle | Inhalt |
|---|---|
| `users` | Konten für die Anmeldung am Hub |
| `settings` | Globale Einstellungen inkl. verschlüsseltem API-Key und Prompt-Framework |
| `sites` | Websites: Token, URL, Sprache, Tonalität, Vorgaben, Übertragungsweg |
| `topics` | Themenliste je Website (`open` / `used`), manuell oder von der KI |
| `plans` | Wiederkehrende Posts: Themenbereiche, Takt, nächster Termin |
| `articles` | Artikel mit Inhalt, SEO-Feldern, Status, Token-Verbrauch und WordPress-Bezug |
| `channels` | Beobachtete YouTube-Kanaele je Website mit Prüfintervall und nächstem Termin |
| `videos` | Gefundene Videos mit Status, Transkript und Bezug zum erzeugten Artikel |
| `images` | Erzeugte Bilder mit Bildbeschreibung, Alt-Text, Unterschrift, Datei und Abrufe-Token |
| `logs` | Protokoll mit Stufe, Bereich, Aktion, Dauer, HTTP-Status und Kontext als JSON |

## Ablauf einer Artikelerzeugung

1. Ein Artikel wird mit Status `generating` angelegt – die Oberfläche fragt den Status alle 5 Sekunden ab.
2. Der Hub baut den Prompt aus drei Teilen:
   - dem **Prompt-Framework** aus den Einstellungen (das *Wie*),
   - dem **Briefing der Website** (Sprache, Zielgruppe, Ton, Marke, Zusatzanweisungen),
   - der **Aufgabe** (Thema, Blickwinkel, Ziellänge).
3. Aufruf der Anthropic Messages API im Streaming-Modus mit `output_config.format`
   (JSON-Schema), damit Titel, Slug, SEO-Felder, Schlagwörter und HTML sauber getrennt zurückkommen.
4. Das HTML wird bereinigt, die Wortzahl bestimmt, alles gespeichert; Status wird `draft`.
5. Enthält die Antwort Bildkonzepte, ruft der Hub anschließend den Bilddienst auf
   (OpenAI-kompatibler Endpunkt `/images/generations`), legt die Dateien unter `data/images`
   ab und macht sie über `/media/<token>` abrufbar. Fehler dabei sind nicht kritisch:
   Der Artikel bleibt nutzbar, das einzelne Bild wird als `failed` vermerkt.
6. Beim Veröffentlichen geht der Artikel an das Plugin, das daraus einen Beitrag anlegt.
   Das Plugin lädt die Bilder über ihre Adresse in die Mediathek (`media_sideload_image`),
   setzt Bild 1 als Beitragsbild und ersetzt die Platzhalter `[[BILD:n]]` im Text durch
   `<figure>` mit Bild und Unterschrift. Platzhalter ohne Bild werden entfernt.

## Übertragungswege

**Sende-Modus (Standard).** Der Hub ruft `POST <website>/wp-json/wp-autoblog/v1/publish` auf.
Voraussetzung: Die WordPress-Seite ist aus dem Internet erreichbar.

**Abhol-Modus.** Der Artikel bleibt im Status `publishing` liegen. Ein WP-Cron-Auftrag
im Plugin fragt alle 15 Minuten `POST <hub>/api/plugin/pending` ab, legt die Beiträge an
und meldet das Ergebnis über `POST <hub>/api/plugin/result` zurück.
Geeignet für Seiten hinter einer Firewall oder ohne öffentliche Adresse.

## Schnittstellen

### Hub → WordPress (signiert)

| Endpunkt | Zweck |
|---|---|
| `POST /wp-json/wp-autoblog/v1/ping` | Verbindungstest, meldet WordPress- und Plugin-Version |
| `POST /wp-json/wp-autoblog/v1/publish` | Beitrag anlegen oder aktualisieren |
| `POST /wp-json/wp-autoblog/v1/update` | Plugin sofort auf den Stand des Hubs bringen |

### WordPress → Hub

| Endpunkt | Signiert | Zweck |
|---|---|---|
| `POST /api/plugin/connect` | nein (Token im Rumpf) | Erstverbindung, meldet URL und Versionen |
| `POST /api/plugin/heartbeat` | ja | Lebenszeichen, liefert Übertragungsweg und Anzahl wartender Artikel |
| `POST /api/plugin/pending` | ja | Wartende Artikel abholen (Abhol-Modus) |
| `POST /api/plugin/result` | ja | Ergebnis einer Veröffentlichung melden |
| `POST /api/plugin/disconnect` | ja | Verbindung von WordPress aus lösen |

### Oberfläche → Hub

Alle Endpunkte unter `/api/app/*` setzen eine Anmeldung voraus:
`sites`, `sites/:id/token`, `sites/:id/test`, `sites/:id/topics`, `sites/:id/topics/suggest`,
`plans`, `plans/:id/run`, `articles`, `articles/:id/publish`, `articles/:id/regenerate`,
`settings`, `settings/reset-prompts`, `diagnostics`, `diagnostics/enable`, `logs`.

### Bilder

`GET /media/:token` liefert ein erzeugtes Bild aus. Der Token ist zufällig und nicht erratbar,
damit WordPress das Bild ohne Anmeldung abholen kann.

### Diagnose (nur mit gültigem Token in der URL)

`GET /diagnose/:token`, `/diagnose/:token/report.json`, `/diagnose/:token/logs.txt`

Der Token gilt, bis er in den Einstellungen deaktiviert oder durch einen neuen ersetzt wird.

## System-Update

Der Hub läuft im Container und darf den Server bewusst nicht selbst steuern. Ein Update
läuft deshalb über einen Dateiaustausch mit einem kleinen Helfer-Dienst auf dem Host
(`ops/autoblog-update-runner.sh`, als systemd-Dienst eingerichtet):

| Datei in `ops/control` | Wer schreibt sie | Inhalt |
|---|---|---|
| `update-request` | der Hub | die Anforderung, ausgelöst durch den Knopf in der Oberfläche |
| `state.json` | der Helfer | Lebenszeichen, aktueller und entfernter Commit, Rückstand, letztes Ergebnis |
| `version.json` | der Helfer | Commit, Commit-Nachricht und Zeitpunkt des Aufspielens |

Der Helfer prüft regelmäßig per `git fetch`, ob es eine neue Version gibt, und meldet das
über `state.json` an den Hub. Bei einer Anforderung führt er `git merge --ff-only` aus
und startet den Hub neu (`docker compose up -d --build`, alternativ `systemctl restart autoblog`).
Nur Vorwärts-Merges sind erlaubt, damit lokale Änderungen auf dem Server niemals still
überschrieben werden. Schlägt der Neustart fehl, setzt der Helfer auf den vorherigen Commit
zurück und startet erneut.

Der Hub bekommt dadurch keinerlei Zugriff auf Docker oder den Server, sondern nur auf
einen Ordner mit drei Dateien.

## YouTube-Beobachtung

1. Stündlich prüft der Zeitplan die fälligen Kanäle über den öffentlichen RSS-Feed
   (`youtube.com/feeds/videos.xml?channel_id=…`). Kein Google-Schlüssel nötig.
2. Neue Videos werden in `videos` aufgenommen. Beim ersten Lauf eines Kanals nur das neueste,
   damit nicht das gesamte Archiv einläuft.
3. Vor der Aufnahme prüft der Hub die Titelähnlichkeit gegen die Videos derselben Website aus
   den letzten drei Tagen. Ab 60 Prozent gemeinsamer Wörter gilt ein Video als Dublette und wird
   übersprungen, weil verschiedene Kanäle oft über dasselbe berichten.
4. Für jedes neue Video holt der Hub das Transkript über einen konfigurierbaren Dienst
   (`src/youtube.js`). Antwortet dieser mit einer Auftragsnummer, wird nachgefragt; HTTP 206 gilt
   als Erfolg, weil Supadata bei langen Videos so antwortet.
5. Aus dem Transkript entsteht ein eigenständiger Artikel. Das Antwortschema hat dafür ein
   zusätzliches Feld `verwertbar`: Ist das Transkript zu dünn, entsteht kein Artikel.
6. Beim Veröffentlichen bettet das Plugin das Quellvideo ein (nackte URL in eigener Zeile, den
   Rest macht die automatische Einbettung von WordPress) und ergänzt unten einen Quellenhinweis.

## Plugin-Updates

Der Hub ist zugleich die Update-Quelle für das WordPress-Plugin. Da die Plugin-Quellen im
selben Repository liegen und mit ins Docker-Image wandern, passt das ausgelieferte Archiv
immer zum Stand des Hubs. Ein Hub-Update aktualisiert also mittelbar auch alle Plugins.

1. Das Plugin fragt signiert bei `POST /api/plugin/update-check` nach und bekommt Version
   und eine Download-Adresse zurück.
2. Die Adresse enthält eine mit `APP_SECRET` signierte Kennung aus Website-ID und Ablaufzeit
   und gilt 30 Minuten. Damit lädt WordPress ohne Anmeldung.
3. Der Hub baut das ZIP-Archiv bei Bedarf selbst (`src/zip.js`, `src/pluginpack.js`) und hält
   es zwischengespeichert, solange sich keine Datei geändert hat.
4. Im Plugin hängt sich `Autoblog_Updater` in `pre_set_site_transient_update_plugins` ein.
   Das Update erscheint dadurch unter „Plugins" wie jedes andere und kann über
   `auto_update_plugin` automatisch eingespielt werden.
5. Zusätzlich kann der Hub das Update sofort auslösen: `POST /wp-json/wp-autoblog/v1/update`
   führt im Plugin einen `Plugin_Upgrader` mit dem Archiv des Hubs aus.

## Zeitsteuerung

Im Hub läuft ein Cron-Job alle 15 Minuten und arbeitet fällige Pläne ab
(`next_run_at <= jetzt`). Der nächste Termin ergibt sich aus „Posts pro Woche"
(168 Stunden geteilt durch die Anzahl) und wird auf die gewünschte Uhrzeit gelegt.
Überlappende Durchläufe werden verhindert.

## Dateien

```
hub/
  src/
    index.js          Server, Anmeldung, Einbindung aller Routen
    config.js         Konfiguration und APP_SECRET
    db.js             SQLite-Schema, Protokollfunktion
    logger.js         Protokollierung mit Zeitmessung und Maskierung
    auth.js           Konten und Sitzungen
    settings.js       Globale Einstellungen, verschlüsselter API-Key
    prompts.js        Mitgeliefertes Prompt-Framework
    ai.js             Anthropic-Anbindung, JSON-Schemata
    sanitize.js       HTML-Positivliste
    images.js         Bildgenerierung, Ablage und Ausliefer-Adressen
    guard.js          Anmeldesperre und Sicherheitskopfzeilen
    zip.js            kleiner ZIP-Schreiber ohne Fremdbibliothek
    pluginpack.js     baut das Plugin-Archiv und signiert die Download-Adressen
    wp.js             Signierte Aufrufe an WordPress
    service.js        Artikelerzeugung, Veröffentlichung, Pläne
    scheduler.js      Zeitsteuerung
    diagnostics.js    Diagnosebericht und Einmal-Token
    update.js         Stand des Systems und Anforderung eines Updates
    routes/           app.js (Oberfläche), plugin.js (WordPress), diagnostics.js, media.js
  public/             Oberfläche (ohne Build-Schritt: index.html, app.js, styles.css)
  test/smoke.js       Funktionsprüfung von außen, Aufruf mit npm test

ops/
  autoblog-update-runner.sh   Update-Helfer, laeuft auf dem Server
  install-updater.sh          richtet ihn einmalig als Dienst ein
  control/                    Austauschordner zwischen Hub und Helfer

wordpress-plugin/autoblog-connector/
  autoblog-connector.php
  includes/
    class-autoblog-settings.php     Optionen
    class-autoblog-hub-client.php   Aufrufe an den Hub
    class-autoblog-publisher.php    Beiträge anlegen, Kategorien, Tags, SEO
    class-autoblog-rest.php         Empfang mit Signaturprüfung
    class-autoblog-admin.php        Einstellungsseite
    class-autoblog-cron.php         Lebenszeichen und Abhol-Modus
```
