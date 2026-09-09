# Autoblog

Ein zweiteiliges System, das Blogartikel erzeugt und automatisch auf beliebig viele
WordPress-Seiten veröffentlicht.

```
┌─────────────────────────┐        Website-Token +          ┌──────────────────────┐
│   Autoblog Hub          │  signierte Übertragung (HMAC)   │  WordPress-Seite A   │
│   (Weboberfläche)       │ ──────────────────────────────► │  Autoblog Connector  │
│                         │                                 └──────────────────────┘
│  • Websites verwalten   │                                 ┌──────────────────────┐
│  • Posts erzeugen       │ ──────────────────────────────► │  WordPress-Seite B   │
│  • Redaktionspläne      │                                 │  Autoblog Connector  │
│  • Prompt-Framework     │                                 └──────────────────────┘
│  • Protokoll & Diagnose │                                 ┌──────────────────────┐
└───────────┬─────────────┘ ──────────────────────────────► │  WordPress-Seite C   │
            │                                               │  Autoblog Connector  │
            ▼                                               └──────────────────────┘
     Claude (Anthropic)
```

## Der Ablauf in Kurzform

1. Im Hub eine Website anlegen → sie bekommt einen **eigenen Token**.
2. Das WordPress-Plugin **Autoblog Connector** installieren, Hub-Adresse und Token eintragen → verbunden.
3. Unter **Posts** entweder einen einzelnen Beitrag erzeugen oder einen **Redaktionsplan**
   (Themenbereiche + wie oft gepostet wird) anlegen.
4. Fertige Artikel prüfen und veröffentlichen – oder automatisch senden lassen.

## Was drin ist

| Bereich | Inhalt |
|---|---|
| `hub/` | Die Weboberfläche (Node.js, SQLite, keine externe Datenbank nötig) |
| `wordpress-plugin/autoblog-connector/` | Das WordPress-Plugin |
| `docs/` | Anleitungen: Installation, Bedienung, Diagnose, Architektur |

## Funktionen

**Hub**
- Mehrere WordPress-Seiten parallel, jede mit eigenem Token, eigener Tonalität und eigener Zielgruppe
- **Posts → Post erzeugen:** einzelner Beitrag zu einem Thema
- **Posts → Wiederkehrende Posts:** Themenbereiche festlegen, Takt festlegen, der Rest läuft automatisch
- **Posts → Gezielte Posts:** vorbereitet für die Keyword-Recherche (nächste Ausbaustufe)
- **Einstellungen:** Anthropic API-Key, Modellwahl und das komplette **Prompt-Framework** frei bearbeitbar
- Artikel im Browser prüfen, bearbeiten, SEO-Felder anpassen und dann veröffentlichen
- Sehr ausführliches Protokoll und eine **Diagnose-URL** mit Einmal-Token

**WordPress-Plugin**
- Verbindung mit einem einzigen Token, keine Passwörter, kein Anwendungspasswort
- Jede Übertragung signiert (HMAC-SHA256) und zeitlich begrenzt gültig
- Legt Beiträge mit Kategorie, Schlagwörtern, Slug, Auszug und SEO-Feldern an (Yoast/Rank Math werden erkannt)
- Zwei Wege: Hub sendet an WordPress **oder** WordPress holt selbst ab (für Seiten hinter einer Firewall)

## Loslegen

Ausführlich in **[docs/01-installation.md](docs/01-installation.md)**. Kurzfassung mit Docker:

```bash
cd wpautoblog
PUBLIC_URL=https://autoblog.meinedomain.de docker compose up -d --build
```

Ohne Docker:

```bash
cd hub
npm install
cp .env.example .env      # PUBLIC_URL eintragen
npm start                 # läuft auf http://localhost:4000
```

Beim ersten Aufruf legst du im Browser dein Konto an. Danach unter **Einstellungen**
den Anthropic API-Key eintragen ([console.anthropic.com](https://console.anthropic.com/settings/keys)).

## Weiterführend

- [Installation](docs/01-installation.md) – Hub aufsetzen, Plugin installieren, verbinden
- [Bedienung](docs/02-bedienung.md) – der Alltag: Posts, Pläne, Prompt-Framework
- [Diagnose](docs/03-diagnose.md) – Protokoll lesen, Diagnose-Link teilen, Fehler einordnen
- [Architektur](docs/04-architektur.md) – wie die Teile zusammenspielen, alle Schnittstellen
- [Roadmap](docs/05-roadmap.md) – was als Nächstes kommt

## Kosten

Bezahlt wird nur, was die KI tatsächlich schreibt (Anthropic-API, nach Token abgerechnet).
Ein Artikel mit rund 1.200 Wörtern kostet mit Claude Opus 5 grob 0,10–0,25 €;
mit Claude Sonnet 5 oder Haiku 4.5 deutlich weniger. Die tatsächlich verbrauchten Token
stehen bei jedem Artikel und gesammelt im Diagnosebericht.
