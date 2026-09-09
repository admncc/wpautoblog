# Installation

Zwei Teile werden installiert: der **Hub** (die Weboberfläche, einmal) und das
**WordPress-Plugin** (auf jeder Seite, die beliefert werden soll).

---

## Teil 1: Den Hub aufsetzen

Der Hub braucht einen Server, der dauerhaft läuft – ein kleiner VPS (1 GB RAM) reicht völlig.
Er speichert alles in einer Datei (SQLite), es wird keine separate Datenbank benötigt.

### Variante A: Mit Docker (empfohlen)

```bash
git clone https://github.com/admncc/wpautoblog.git
cd wpautoblog
PUBLIC_URL=https://autoblog.meinedomain.de docker compose up -d --build
```

Danach ist der Hub auf Port 4000 erreichbar. Für den Betrieb im Netz einen Reverse Proxy
mit HTTPS davorsetzen (Caddy, Nginx Proxy Manager, Traefik). Beispiel für Caddy:

```
autoblog.meinedomain.de {
    reverse_proxy 127.0.0.1:4000
}
```

### Variante B: Ohne Docker

Voraussetzung: Node.js 20 oder neuer.

```bash
git clone https://github.com/admncc/wpautoblog.git
cd wpautoblog/hub
npm install
cp .env.example .env
nano .env          # PUBLIC_URL eintragen
npm start
```

Für den Dauerbetrieb einen Dienst einrichten, damit der Hub nach einem Neustart wieder läuft
(`systemd`, `pm2` oder ähnlich).

### Erster Start

1. Hub im Browser öffnen (z. B. `https://autoblog.meinedomain.de`).
2. Konto anlegen – E-Mail und Passwort (mindestens 8 Zeichen). Das passiert nur einmal.
3. Auf **Einstellungen** gehen und den **Anthropic API-Key** eintragen.
   Den Key gibt es unter [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
   Der Key wird verschlüsselt gespeichert und nie wieder im Klartext angezeigt.

> **Wichtig bei einem Serverumzug:** Die Datei `data/.app_secret` mitnehmen.
> Ohne sie lassen sich der gespeicherte API-Key und die Website-Token nicht mehr entschlüsseln.

---

## Teil 2: Das WordPress-Plugin installieren

Auf **jeder** WordPress-Seite, die beliefert werden soll:

1. Aus dem Ordner `wordpress-plugin/autoblog-connector` ein ZIP-Archiv erstellen:

   ```bash
   cd wordpress-plugin && zip -r autoblog-connector.zip autoblog-connector
   ```

2. In WordPress: **Plugins → Installieren → Plugin hochladen** → ZIP auswählen → installieren → aktivieren.

   *Alternativ per FTP:* den Ordner `autoblog-connector` nach `wp-content/plugins/` kopieren und
   das Plugin unter "Plugins" aktivieren.

---

## Teil 3: Verbinden

1. Im Hub auf **Websites → Neue Website anlegen**. Name eingeben (z. B. „Kaffeeblog"), anlegen.
2. Die Website öffnet sich im Reiter **Verbindung**. Dort stehen zwei Angaben:
   - die **Hub-Adresse**
   - der **Website-Token** (beginnt mit `wpab_`)
3. In WordPress: **Einstellungen → Autoblog**. Beide Angaben einfügen, optional den Autor wählen,
   auf **Verbinden** klicken.
4. Zurück im Hub: **Verbindung testen**. Steht dort „Verbunden mit WordPress …", ist alles fertig.

### Wenn die Verbindung nicht klappt

| Meldung | Ursache und Lösung |
|---|---|
| „Token unbekannt" | Der Token wurde nicht vollständig kopiert oder im Hub neu erzeugt. Im Hub erneut kopieren. |
| „WordPress nicht erreichbar" | Die Website ist von außen nicht erreichbar (lokale Installation, Firewall, Wartungsmodus). Lösung: im Hub unter **Verbindung → Übertragungsweg** auf „WordPress holt selbst ab" umstellen. |
| „Unerwartete Antwort von WordPress" | Das Plugin ist nicht aktiv, oder die REST-API von WordPress ist gesperrt (manche Sicherheits-Plugins tun das). |
| „Zeitstempel abgelaufen" | Die Uhr des WordPress-Servers weicht mehr als 5 Minuten ab. Zeitsynchronisation prüfen. |
| „Signatur ungültig" | Im Plugin steht ein alter Token. Im Hub kopieren und im Plugin ersetzen. |

Ausführlicher: [Diagnose](03-diagnose.md).

---

## Weitere Websites hinzufügen

Für jede weitere WordPress-Seite: im Hub eine neue Website anlegen (eigener Token),
Plugin dort installieren, Token eintragen. Jede Seite bekommt ihren eigenen Token –
ein Token gilt immer nur für genau eine Website.
