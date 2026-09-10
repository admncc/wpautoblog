# Protokoll und Diagnose

Der Hub schreibt bewusst sehr ausführlich mit: **jede** HTTP-Anfrage, jeder KI-Aufruf,
jede Übertragung an WordPress, jeder Anmeldeversuch und jeder Plan-Durchlauf –
jeweils mit Dauer, Ergebnis und den passenden Details.

## Das Protokoll in der Oberfläche

Unter **Protokoll** lässt sich filtern nach:

- **Stufe:** Debug (sehr fein), Info, Warnung, Fehler
- **Bereich:** HTTP-Anfragen, KI, Artikel, WordPress, Plugin, Pläne, Zeitplan, Anmeldung, System …

Jede Zeile lässt sich über **Details** aufklappen – dort steht der vollständige Kontext,
zum Beispiel bei einem KI-Aufruf das verwendete Modell, die Token-Zahlen und ein Auszug des Prompts,
bei einer WordPress-Übertragung die Ziel-URL, der HTTP-Status und die Antwort.

Geheimnisse werden dabei automatisch unkenntlich gemacht: API-Keys, Website-Token,
Signaturen und Passwörter erscheinen nur gekürzt (`wpab_gLA…(37 Zeichen)`).

## Die Diagnose-URL

Manchmal soll jemand anderes draufschauen, ohne ein Konto zu bekommen.
Dafür gibt es unter **Einstellungen → Diagnose-Zugang** einen Link:

1. Auf **Neuen Diagnose-Link erzeugen** klicken.
2. Es entsteht ein **neuer Token** – der vorher erzeugte Link funktioniert ab diesem Moment nicht mehr.
3. Der Link bleibt gültig, bis du ihn selbst beendest: entweder mit **Zugang deaktivieren**
   oder indem du einen neuen Link erzeugst, der den alten ersetzt.

Der Link führt auf drei Ansichten:

| Adresse | Inhalt |
|---|---|
| `/diagnose/<token>` | Lesbare Übersicht im Browser: Kennzahlen, Websites, fehlgeschlagene Artikel, Protokoll |
| `/diagnose/<token>/report.json` | Vollständiger Bericht als JSON – zur Auswertung |
| `/diagnose/<token>/logs.txt` | Nur das Protokoll als reiner Text |

Die JSON- und Textansicht lassen sich filtern:

```
/diagnose/<token>/report.json?level=error          nur Fehler
/diagnose/<token>/report.json?category=wordpress   nur WordPress-Übertragungen
/diagnose/<token>/logs.txt?limit=2000              die letzten 2000 Zeilen
```

Im Bericht stehen: Hub-Version und Laufzeit, Node-Version und Systemauslastung,
alle Einstellungen (ohne Geheimnisse), Zählwerte, Token-Verbrauch je Modell,
alle Websites mit Verbindungsstatus, alle Pläne, die letzten Artikel,
alle fehlgeschlagenen Artikel mit Fehlermeldung und das Protokoll.

> **Wichtig:** Wer den Link hat, sieht diese Daten – ohne Anmeldung.
> Nur an Personen weitergeben, denen der Systemzustand zugänglich sein soll,
> und danach einen neuen Token erzeugen oder den Zugang deaktivieren.

## Typische Fehlerbilder

| Meldung im Protokoll | Bedeutung |
|---|---|
| `plugin/auth: Signatur stimmt nicht` | Im WordPress-Plugin steht ein anderer Token als im Hub. Token im Hub kopieren und dort ersetzen. |
| `plugin/auth: Zeitstempel abgewiesen` | Die Uhren von Hub und WordPress-Server weichen mehr als 5 Minuten ab. |
| `wordpress/publish: WordPress nicht erreichbar` | Netzwerk, DNS oder TLS. Die Details enthalten die aufgerufene URL. |
| `wordpress/publish: Antwort war kein JSON` | Meist ist das Plugin nicht aktiv oder die REST-API ist gesperrt. |
| `ai/article: 401` | Der Anthropic API-Key ist falsch oder abgelaufen. |
| `ai/article: 429` | Das Limit bei Anthropic ist erreicht – später erneut versuchen. |
| `ai/article: Antwort wurde durch max_tokens abgeschnitten` | Die gewünschte Artikellänge ist zu groß. Länge reduzieren. |
| `plan/run: kein Thema verfügbar` | Der Plan hat keine Themenbereiche und die Themenliste ist leer. |
| `image/generate: Bilddienst meldet einen Fehler` | Schlüssel, Modell oder Format des Bilddienstes prüfen. Der Artikel bleibt trotzdem nutzbar. |
| `image/deliver: PUBLIC_URL ist nicht gesetzt` | Ohne öffentliche Hub-Adresse kann WordPress die Bilder nicht abholen. |

## Funktionsprüfung

Nach jedem Update lässt sich das System selbst überprüfen:

```bash
cd /opt/wpautoblog/hub && npm test
```

Der Test startet einen Hub mit einer leeren Datenbank in einem temporären Ordner, stellt ein
WordPress und einen Bilddienst nach und geht 43 Prüfungen durch: Anmeldung und Sperren,
Signaturprüfung, Verbindungsaufbau, Themen, Pläne, Artikel, Bilder, beide Übertragungswege,
Archivierung, Plugin-Update und Diagnose. Es entstehen dabei keine Kosten, weil kein echter
Anthropic-Aufruf stattfindet. Am Ende steht die Zahl der bestandenen Prüfungen; bei einem
Fehlschlag werden die letzten Protokollzeilen mit ausgegeben.

## Aufbewahrung

Protokolleinträge werden 7 Tage aufbewahrt, Debug-Einträge 2 Tage.

Das Aufräumen läuft täglich um 03:30 UTC. Es entfernt außerdem Bilddateien, deren Artikel
gelöscht wurde, und die Bilddateien veröffentlichter Artikel, die älter als 90 Tage sind.
Letztere werden nicht mehr gebraucht, weil sie längst in der WordPress-Mediathek liegen.
Bildbeschreibung und Alt-Text bleiben erhalten. Alles liegt in der Datei
`data/autoblog.sqlite` – für eine Sicherung reicht es, den Ordner `data/` zu kopieren.
