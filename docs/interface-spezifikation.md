# Autoblog Hub — Funktions- und Designbeschreibung

Stand: 11. September 2026 · Diese Datei beschreibt den Ist-Zustand der Oberfläche
vollständig. Sie ist als Auftragsgrundlage für eine Design-Überarbeitung gedacht.

---

## 0. Auftrag

Die Oberfläche funktioniert, sieht aber aus wie das, was sie ist: ein Werkzeug, das
entlang der Technik gewachsen ist. Gesucht ist eine Überarbeitung, die

- die **Hierarchie** klärt (was ist Hauptaufgabe, was ist Einstellung, was ist Diagnose),
- **Zustände sichtbar** macht (läuft, wartet, fehlgeschlagen, veröffentlicht),
- **lange Listen** beherrschbar macht (38 Kategorien, 50 Themen, 200 Protokollzeilen),
- die **Bedienung für einen Nicht-Entwickler** selbsterklärend macht.

Nicht gesucht: eine andere Informationsarchitektur um ihrer selbst willen, englische
Beschriftungen, ein Framework-Umbau. Abschnitt 9 nennt, was unangetastet bleiben muss.

---

## 1. Was das System ist

Der **Autoblog Hub** ist ein selbst gehostetes Redaktionswerkzeug. Es erzeugt mit
Claude vollständige Blogartikel samt Bildern und veröffentlicht sie auf mehreren
WordPress-Seiten. Auf jeder WordPress-Seite läuft ein kleines Begleit-Plugin
(*Autoblog Connector*), das über einen Token mit dem Hub verbunden ist.

**Ein Nutzer.** Der Betreiber mehrerer Blogs. Kein Entwickler. Arbeitet am Schreibtisch
am großen Bildschirm, schaut gelegentlich vom Handy nach, ob etwas fehlgeschlagen ist.
Er meldet sich nicht täglich an: Das System soll ohne ihn laufen und nur dann nach ihm
rufen, wenn etwas klemmt.

**Das mentale Modell**, in dieser Reihenfolge:

1. **Website** anlegen und mit WordPress verbinden (einmalig)
2. **Vorgaben** hinterlegen: Zielgruppe, Tonalität, Kategorien, Sprache
3. **Themen** sammeln (von Hand oder von der KI vorschlagen lassen)
4. **Plan** aufsetzen: zweimal pro Woche, automatisch senden
5. **Laufen lassen.** Der Hub schreibt, bebildert, wählt die Kategorie und sendet.
6. **Nachsehen**, wenn etwas rot ist.

Daneben zwei Quellen, aus denen Artikel entstehen können, ohne dass ein Thema von Hand
eingetragen wird:

- **YT Channel Spy:** beobachtet YouTube-Kanäle, liest bei neuen Videos das Transkript
  und macht daraus einen eigenständigen Artikel.
- **Gezielte Posts:** ein Beitrag, der für einen recherchierten Suchbegriff stehen soll,
  mit eigenem, strengerem Regelwerk.

---

## 2. Technische Rahmenbedingungen

Diese Punkte sind hart, ein Entwurf muss sie einhalten:

| Punkt | Bedeutung für das Design |
|---|---|
| **Kein Build-Schritt.** Eine `index.html`, eine `app.js` (1770 Zeilen), eine `styles.css` (152 Zeilen). Kein React, kein Tailwind, kein Sass. | Alles Neue muss als handgeschriebenes CSS und als String-Template funktionieren. Utility-Klassen in großer Zahl sind unpraktisch, weil das HTML in JavaScript-Strings steckt. |
| **Content-Security-Policy** erlaubt nur eigene Skripte und Stile von der eigenen Adresse. `style-src` erlaubt zusätzlich `unsafe-inline`. | Keine Webfonts von Google, kein CDN, keine externen Icon-Bibliotheken. Schriften nur aus dem System-Stack oder selbst mitgeliefert. Icons als Inline-SVG oder Unicode. |
| **Hash-Routing**, alles in einer Seite. `#/dashboard`, `#/sites`, `#/site/<id>`, `#/posts`, `#/articles`, `#/article/<id>`, `#/settings`, `#/logs`. | Kein Seitenwechsel, kein Ladezustand des Browsers. Übergänge und Ladeanzeigen muss die Oberfläche selbst zeigen. |
| **Neuzeichnen statt Aktualisieren.** Fast jede Aktion baut die ganze Ansicht neu auf (`render()`). | Zustände wie „Reiter offen", „Filter gesetzt" leben in einem `state`-Objekt. Aufgeklappte Details gehen beim Neuzeichnen verloren, das ist heute ein spürbarer Mangel. |
| **Dunkelmodus** folgt dem Betriebssystem (`prefers-color-scheme`), keine Umschaltmöglichkeit. | Jede neue Farbe braucht beide Fassungen. Ein Umschalter wäre eine sinnvolle Ergänzung. |
| **Serverseitig gerendertes HTML gibt es nicht.** Alle Daten kommen als JSON über `/api/app/...`. | Jede Ansicht hat einen Ladezustand, einen Leerzustand und einen Fehlerzustand. Heute sind die oft nur ein grauer Satz. |

---

## 3. Grundgerüst und Navigation

```
┌─────────────┬──────────────────────────────────────────────┐
│  Seitenleiste│  Hauptbereich (max. 1120 px, 26/30 px Rand)  │
│  232 px      │                                              │
│              │  ┌ page-head ─────────────────────────────┐  │
│  AB  Hub-Name│  │ H1 + Unterzeile        [Aktionsknöpfe] │  │
│              │  └────────────────────────────────────────┘  │
│  Übersicht   │                                              │
│  Websites    │  ┌ card ──────────────────────────────────┐  │
│  Posts       │  │ H2                                     │  │
│  Artikel     │  │ Inhalt                                 │  │
│  Einstellungen│ └────────────────────────────────────────┘  │
│  Protokoll   │                                              │
│              │  ┌ card ──────────────────────────────────┐  │
│  ────────────│  │ ...                                    │  │
│ [System-Update]│└────────────────────────────────────────┘  │
│  v1.4.1      │                                              │
│ [Abmelden]   │                                              │
└─────────────┴──────────────────────────────────────────────┘
```

Unter 760 px Breite wird aus dem Raster eine Spalte, die Seitenleiste sitzt oben als
Band. Das ist die einzige Anpassung, die es heute gibt, und sie ist die schwächste
Stelle der ganzen Oberfläche.

**Die Fußzeile der Seitenleiste** enthält den System-Update-Knopf mit Versionsstand
(„aufgespielt 10.09.26, 06:11"), bei verfügbarem Update einen blauen Hinweis, bei
fehlgeschlagenem Update einen roten mit Link zum Protokoll. Während eines Updates
läuft eine Overlay-Anzeige über die ganze Seite, die den Neustart abwartet.

---

## 4. Die Bildschirme im Einzelnen

### 4.1 Anmeldung

Zentrierte Karte, 380 px breit. Marke, ein Satz, E-Mail, Passwort, ein Knopf über die
volle Breite. Zwei Fassungen: **Ersteinrichtung** („Willkommen! Lege dein Konto an.",
Hinweis „Mindestens 8 Zeichen.") und **Anmeldung**. Fehler erscheinen als rote Leiste
über den Feldern. Nach fünf Fehlversuchen sperrt der Server die Adresse zeitweise, die
Meldung kommt als Text.

### 4.2 Übersicht (`#/dashboard`)

- **Kopf:** H1 „Übersicht", Unterzeile, rechts zwei Knöpfe („Website hinzufügen",
  „Post erzeugen").
- **Warnleiste**, wenn kein Anthropic-Schlüssel hinterlegt ist. Rot, mit Link.
- **Vier Kennzahlen** nebeneinander: Websites verbunden (`3/5`), veröffentlicht,
  Entwürfe, aktive Pläne. Große Zahl, darunter ein Großbuchstaben-Label.
- **Zwei Karten nebeneinander:** „Websites" (Name, URL, Status-Abzeichen, Zeile
  anklickbar) und „Zuletzt erzeugt" (Titel, Website, Datum, Status-Abzeichen).
- **Karte „Letzte Ereignisse":** die letzten Protokollzeilen als Zeitstempel + Text,
  Fehler rot, Warnungen bernstein.

*Schwäche:* Die Seite beantwortet nicht die eine Frage, mit der der Nutzer kommt:
**Muss ich etwas tun?** Fehlgeschlagene Artikel, wartende Videos und offene Entwürfe
stehen gleichrangig neben Erfolgsmeldungen.

### 4.3 Websites (`#/sites`)

Karte „Neue Website anlegen" (Name, Adresse) und darunter die Liste der Websites mit
Status-Abzeichen. Bei fünf Einträgen unspektakulär, aber der Einstieg in die
wichtigste Detailseite.

### 4.4 Website-Detail (`#/site/<id>`) — die dichteste Seite

Kopf: Name, darunter URL und Verbindungsstatus, rechts „Verbindung testen" und
„Löschen". Fünf Reiter:

**a) Verbindung**
- Karte „WordPress verbinden": Hub-Adresse und Website-Token, beide als
  Monospace-Kästchen mit gestricheltem Rahmen und je einem Kopieren-Knopf, dazu
  „Neu erzeugen" für den Token.
- Karte „WordPress-Plugin": installierte Version, im Hub bereitliegende Version,
  Abzeichen „aktuell" oder „Update verfügbar", Knopf „Plugin aktualisieren".
- Karte **„Kategorien"**: alle von WordPress gemeldeten Kategorien als Chips mit
  Beitragszahl (`Spiritualität · 409`). Jeder Chip hat rechts ein kleines ×; ein Klick
  schließt die Kategorie von der KI-Auswahl aus, der Chip wird rot und das × zu einem ↺.
  **Bei maikikii.de sind das 38 Chips in fünf Zeilen** — der Stresstest für jeden Entwurf.
- Karte „Übertragungsweg": Hub sendet an WordPress (Standard) oder WordPress holt ab.

**b) Inhalt & Stil**
Ein langes Formular in einer Karte: Name, WordPress-Adresse, Sprache, Artikellänge,
Zielgruppe, Tonalität, Themenschwerpunkte, ein großes Freitextfeld „Zusätzliche
Anweisungen an die KI", Kategorie in WordPress (Auswahlliste, Standard „KI wählt die
passendste"), Autor-ID, Speichern-Knopf.

*Schwäche:* 10 Felder ohne Gruppierung, alle gleich gewichtet. Die beiden Felder, die
den Text am stärksten prägen (Zielgruppe, Zusätzliche Anweisungen), sehen aus wie die
Autor-ID.

**c) Themen**
- Karte „Themen sammeln": Textfeld für eigene Themen (eine Zeile pro Thema), Knopf
  „Hinzufügen", daneben „Von der KI vorschlagen lassen".
- Karte „Offene Themen (50)": Liste mit Löschknopf je Zeile und „Artikel schreiben".

*Schwäche:* 50 Zeilen ohne Suche, ohne Sortierung, ohne Mehrfachauswahl.

**d) YT Channel Spy**
- Karte „Kanal beobachten": Eingabefeld für Kanal-Adresse, @handle oder Kanal-ID, dazu
  Intervall, Videos je Durchlauf, Blickwinkel, zwei Kästchen (automatisch Artikel,
  Video einbetten).
- Karte „Beobachtete Kanäle (3)": je Kanal eine Zeile mit Titel, Abzeichen (aktiv /
  pausiert / automatisch), einer Hinweiszeile („alle 24 Stunden, höchstens 1 Video je
  Durchlauf · 39 gefunden, 2 Artikel · zuletzt … · nächste Prüfung …"), drei Knöpfen
  (Jetzt prüfen, Pausieren, Entfernen) und darunter einer Einstellungsreihe
  (Wie oft prüfen, Videos je Durchlauf, Blickwinkel, automatisch, Speichern).
- Karte „Gefundene Videos": Tabelle mit Titel, Kanal, Link zu YouTube, Status-Abzeichen
  (wartet / übersprungen / Artikel / Fehler), Veröffentlichungsdatum, Knöpfen
  („Artikel erzeugen", „Überspringen"). Unter dem Titel steht je nach Lage ein Hinweis:
  „Wird beim nächsten stündlichen Durchlauf von selbst zum Artikel", „Neuer Anlauf am
  …, (Versuch 2)" oder die Fehlermeldung. Übersprungene Videos stecken in einem
  zugeklappten `<details>`-Block („38 übersprungene Videos aus dem letzten Durchlauf
  anzeigen").

*Schwäche:* Die Kanalzeile trägt 12 Bedienelemente. Die Einstellungsreihe steht immer
offen, obwohl sie selten gebraucht wird.

**e) Artikel**
Karte „Artikel schreiben" (Thema, Blickwinkel) und die Artikeltabelle dieser Website.

### 4.5 Posts (`#/posts`)

Drei Reiter:

**Post erzeugen** — Website, Thema, Blickwinkel, ein Knopf. Der direkteste Weg im
ganzen Werkzeug.

**Wiederkehrende Posts** — Formular „Neuen Plan anlegen" (Website, Name, Themenbereiche
als mehrzeiliges Feld, Posts pro Woche, Uhrzeit UTC, Kästchen „automatisch senden")
und darunter „Laufende Pläne (5)". Jede Plankarte zeigt Name, Abzeichen (aktiv, sendet
automatisch), eine Hinweiszeile („speedxtc.com · 2× pro Woche · 0 Posts erzeugt ·
nächster Lauf: 13.09.26, 11:00"), rechts drei Knöpfe (Pausieren, Jetzt ausführen,
Löschen) und darunter das Themenbereiche-Feld mit „pro Woche", „Uhrzeit" und
„Speichern".

*Schwäche:* Jede Plankarte ist ein vollständiges Formular. Fünf Pläne sind fünf offene
Formulare untereinander. Das Themenbereiche-Feld ist so niedrig, dass von sechs Zeilen
zweieinhalb zu sehen sind.

**Gezielte Posts** — Formular für einen Beitrag auf einen recherchierten Suchbegriff:
Website, Suchbegriff, Suchabsicht, Suchvolumen, Schwierigkeit, Nebenbegriffe, Fragen
(mehrzeilig), „Das haben die führenden Treffer schon" und „Das fehlt dort" (zwei
mehrzeilige Felder nebeneinander), Blickwinkel. Darunter eine Karte „Automatische
Recherche (in Vorbereitung)".

### 4.6 Artikel (`#/articles`)

Kopf mit Auswahlliste „Alle Websites", zwei Reiter „In Arbeit (3)" und „Archiv (10)".
Tabelle: Titel (darunter Website, Kennzeichen-Abzeichen „wiederkehrend", „Video",
„gezielt", und die fertige WordPress-Adresse als Link), Status, Wörter, Erstellt.

Status-Abzeichen: `wird erzeugt …` (blau), `Entwurf`, `wird gesendet`, `veröffentlicht`
(grün), `Fehler` (rot), `wartet auf Abholung`.

### 4.7 Artikel-Detail (`#/article/<id>`)

- **Während der Erzeugung:** eine leere Karte mit „Der Artikel wird gerade geschrieben.
  Das dauert etwa 1–3 Minuten." und einem Selbstaktualisierer alle 5 Sekunden.
  *Schwäche:* kein Fortschritt, keine Bewegung, kein Abbruch.
- **Fertig:** Kopf mit Titel, darunter eine Zeile aus Website, Status, Wortzahl, Modell,
  Link „in WordPress ansehen", bei Videoartikeln „Video · Quelle ansehen". Rechts vier
  Knöpfe: An WordPress senden, Neu schreiben, Archivieren, Löschen.
- Darunter gegebenenfalls eine rote Fehlerleiste und eine bernsteinfarbene Hinweisleiste
  (etwa die Wortlaut-Prüfung bei Videoartikeln).
- Vier Reiter: **Vorschau** (gerenderter Beitrag in einem abgesetzten Rahmen),
  **Bearbeiten** (Titel, Auszug, HTML in einem Monospace-Feld, Speichern),
  **SEO** (Meta-Titel, Meta-Beschreibung, Schlagwörter, Kategorie),
  **Bilder** (die erzeugten Bilder mit Bildunterschrift und Alternativtext,
  Knopf „Bilder neu erzeugen").

### 4.8 Einstellungen (`#/settings`)

Sechs Karten untereinander, jede mit eigenem Speichern-Knopf:

1. **Anthropic API-Key** — Passwortfeld, Modellwahl, Aufwandsstufe (niedrig bis sehr hoch)
2. **Marke & Standardvorgaben** — Hub-Name, Markenname, Markenbeschreibung,
   Standardsprache, Standardlänge, Standard-Tonalität, globale Vorgaben
3. **Bilder** — Anbieter, Basisadresse, Modell, Größe, Qualität, Bildstil, Anzahl je Artikel
4. **YouTube-Kanäle und Transkripte** — Schalter, Schlüssel des Transkript-Dienstes,
   Abrufadresse, Header-Name, Videoquelle (Automatisch / Supadata / RSS / Google /
   Kanalseite), Google-Schlüssel, zwei große Prompt-Felder
5. **Diagnose-Zugang** — erzeugt eine geheime Adresse, über die ein Helfer ohne Anmeldung
   den vollständigen Zustandsbericht lesen kann. Mit Kopieren und Deaktivieren.
6. **Prompt-Framework** — drei sehr große Textfelder (Artikel, Themen, Video, Gezielt),
   dazu „Standard wiederherstellen"

*Schwäche:* Eine Seite, sechs Speichern-Knöpfe, dazwischen Textfelder mit über 11.000
Zeichen. Es gibt keine Gliederung, keine Sprungmarken, keinen Hinweis auf ungespeicherte
Änderungen.

### 4.9 Protokoll (`#/logs`)

Kopf mit drei Auswahllisten (Stufe, Bereich, Anzahl) und „Aktualisieren". Tabelle:
Zeit, Stufe (Abzeichen), Bereich (`article/generate`), Dauer in ms, Meldung. Jede Zeile
kann einen aufklappbaren Details-Block mit formatiertem JSON haben.

*Schwäche:* 200 Zeilen ohne Suche, ohne Gruppierung nach Vorgang. Das Aufklappen geht
beim nächsten Neuzeichnen verloren.

---

## 5. Wiederkehrende Bausteine

| Baustein | Klasse | Verwendung heute |
|---|---|---|
| Karte | `.card` | Der einzige Container. Alles steckt in Karten. |
| Seitenkopf | `.page-head` | H1 + `.sub` links, Knopfreihe rechts |
| Kennzahl | `.stat` | nur auf der Übersicht, vier Stück |
| Abzeichen | `.badge` + `.ok .warn .err .info` | Status, Kennzeichen, Kategorien |
| Leiste | `.notice` + `.ok .err .info` | Fehler, Hinweise, Erfolg |
| Reiter | `.tabs` | Website (5), Posts (3), Artikel (4), Artikelliste (2) |
| Tabelle | `table` | Artikel, Videos, Themen, Protokoll |
| Feld | `.field` + `label` + `.hint` | überall |
| Leerzustand | `.empty` | grauer, zentrierter Satz |
| Kurzmeldung | Toast | erscheint nach Aktionen |
| Modal | `.modal-backdrop` / `.modal` | nur für den Verbindungsfehler-Bericht |
| Kopierkästchen | `code.pair` | Hub-Adresse, Token, Kopplungscode |

---

## 6. Gestaltung heute

**Farben (hell):**
`--bg #f5f6f8` · `--panel #ffffff` · `--panel-2 #fafbfc` · `--border #e2e5ea` ·
`--text #1c2024` · `--muted #6b7480` · `--accent #2f6feb` · `--accent-soft #eaf1fe` ·
`--green #1a7f4b` / `#e6f5ec` · `--amber #9a6300` / `#fdf3e0` · `--red #b3261e` / `#fdecea`

**Farben (dunkel):**
`--bg #14161a` · `--panel #1c1f24` · `--panel-2 #22262c` · `--border #2e333a` ·
`--text #e8eaed` · `--muted #98a1ad` · `--accent #6f9dff` · `--accent-soft #1e2a44` ·
`--green #6bd39b` / `#14301f` · `--amber #e0aa4a` / `#33270f` · `--red #ef8880` / `#35191a`

**Form:** `--radius 10px`, Knöpfe und Felder 8 px, Auth-Karte 14 px, Abzeichen rund.
**Schatten:** sehr flach, zweistufig.
**Schrift:** System-Stack, 15 px Grundgröße, Zeilenhöhe 1.55. H1 22 px, H2 17 px,
H3 15 px, Hinweise 12.5 px, Tabellen 14 px.
**Abstände:** Karte 18 px innen, 16 px Abstand nach unten. Raster 14 px.
Hauptbereich 26 px oben, 30 px seitlich, maximal 1120 px breit.

**Was gestalterisch fehlt:**

- **Keine Symbole.** Nirgendwo ein Icon, nicht einmal in der Navigation.
- **Nur eine Akzentfarbe**, gleichzeitig für Links, Hauptknöpfe, aktive Reiter und
  Info-Abzeichen. Nichts hat dadurch Vorrang.
- **Keine Typo-Hierarchie unterhalb von H2.** Alles darunter ist entweder 15 px Text
  oder 12.5 px grau.
- **Keine Bewegung.** Kein Übergang, keine Ladeanimation, kein Skelett.
- **Tabellen ohne Zebrastreifen, ohne feste Kopfzeile, ohne Sortierung.**
- **Knopfreihen ohne Rangfolge.** „Löschen" sieht aus wie „Pausieren", nur der Text ist rot.

---

## 7. Zustände, die ein Entwurf abbilden muss

| Zustand | Wo | Heute |
|---|---|---|
| leer (frisch installiert) | jede Liste | ein grauer Satz |
| lädt | jede Ansicht | „Lädt …" |
| arbeitet (1–3 Minuten) | Artikel-Erzeugung | Text, kein Fortschritt |
| wartet auf Zeitplan | Videos, Pläne | Abzeichen + Hinweiszeile |
| fehlgeschlagen, erneuter Anlauf | Videos | Hinweis mit Zeitpunkt |
| fehlgeschlagen, endgültig | Artikel | rote Leiste mit Meldung |
| Warnung, aber nutzbar | Wortlaut-Prüfung | bernsteinfarbene Leiste |
| nicht verbunden | Website | Abzeichen „wartet auf Plugin" |
| Update verfügbar | Seitenleiste, Plugin | Hinweis bzw. Abzeichen |
| gesperrt / ausgeschlossen | Kategorie-Chip | rot |

---

## 8. Die konkrete Bitte an den Entwurf

Nach Wichtigkeit geordnet:

1. **Eine Übersicht, die Handlungsbedarf zeigt.** Oben gehört hin, was klemmt:
   fehlgeschlagene Artikel, Videos mit Fehler, nicht verbundene Websites, abgelaufene
   Schlüssel. Kennzahlen sind zweitrangig.
2. **Lange Listen bändigen.** 38 Kategorie-Chips, 50 Themen, 40 Videos, 200
   Protokollzeilen. Es braucht Suche, Gruppierung, Zusammenklappen und eine
   Mehrfachauswahl.
3. **Formulare gliedern.** „Inhalt & Stil" und „Einstellungen" brauchen Gruppen mit
   Zwischenüberschriften, und die Felder, die den Text prägen, müssen anders aussehen
   als die technischen.
4. **Die Plankarte entzerren.** Anzeige und Bearbeitung trennen, das Bearbeiten
   aufklappbar oder in einen Dialog.
5. **Rangfolge in Knopfreihen.** Eine Hauptaktion je Bereich, der Rest zurückgenommen,
   Zerstörendes abgesetzt.
6. **Wartezustände gestalten.** Artikel-Erzeugung, Verbindungstest, System-Update und
   Kanalprüfung dauern spürbar lange.
7. **Mobil brauchbar machen.** Heute bricht alles auf eine Spalte um, Tabellen laufen
   über den Rand. Für das Handy zählt vor allem: Was ist fehlgeschlagen, und kann ich
   einen Entwurf freigeben?
8. **Symbole einführen**, mindestens in der Navigation und für die Statusarten. Als
   Inline-SVG, keine externe Bibliothek.
9. **Dunkelmodus umschaltbar machen**, nicht nur dem System folgend.

---

## 9. Unantastbar

**Beschriftungen bleiben deutsch** und in der bestehenden Ansprache (Du-Form, keine
Fachbegriffe ohne Erklärung). Der Ton der Hinweistexte ist Teil des Produkts:
erklärend, ohne Marketing, ohne Ausrufezeichen.

**Diese Haken dürfen nicht verschwinden.** Das JavaScript bindet sein Verhalten an
Kennungen und Datenattribute. Ein Entwurf darf Aussehen und Anordnung ändern, muss
diese Namen aber am jeweiligen Element lassen:

*Kennungen (`id`):*
`auth-form, email, password, logout, do-update, show-update-log, new-site, site-name,
site-url, test-connection, delete-site, new-token, update-plugin, tab-body, posts-body,
generate-form, gen-site, gen-keyword, gen-angle, plan-form, plan-site, plan-name,
plan-areas, plan-per-week, plan-hour, plan-auto-publish, target-form, write-form,
keyword, keywords, add-topics, suggest-topics, channel-form, chan-input, chan-interval,
chan-max, chan-angle, chan-auto, chan-embed, filter-site, publish, regenerate,
toggle-archive, delete-article, save-article, regen-images, save-settings,
save-settings-2, save-settings-3, save-settings-4, reset-prompts, anthropic_api_key,
image_api_key, transcript_api_key, youtube_api_key, youtube_enabled, diagnostics-box,
diag-enable, diag-disable, diag-copy, diag-url, log-level, log-category, log-limit,
reload`

*Datenattribute:*
`data-site, data-article, data-tab, data-ptab, data-atab, data-copy, data-write,
data-arch, data-del-topic, data-run-plan, data-save-plan, data-toggle-plan,
data-del-plan, data-save-site, data-exclude, data-scan, data-save-chan,
data-toggle-chan, data-del-chan, data-int, data-max, data-angle, data-auto, data-make,
data-skip`

*Formularfelder in „Inhalt & Stil"* tragen die Kennungen `name, url, language,
word_count, audience, tone, topic_focus, extra_prompt, wp_category, wp_author_id,
wp_status, delivery` und werden über genau diese Namen ausgelesen.

Die Klassen `.card .page-head .sub .stat .badge .notice .tabs .field .hint .empty .row
.grid .preview .logline .pair .chip-x .btn` dürfen umgestaltet, aber nicht umbenannt
werden, solange das JavaScript sie erzeugt.

---

## 10. Prüffälle für den Entwurf

Ein Entwurf sollte an diesen echten Situationen gezeigt werden:

1. **Übersicht mit Problemen:** 5 Websites, davon 1 nicht verbunden, 3 fehlgeschlagene
   Artikel, 1 Video im Fehlerzustand, kein Bildschlüssel hinterlegt.
2. **Kategorien bei maikikii.de:** 38 Chips, 6 davon ausgeschlossen, Namen zwischen
   4 und 24 Zeichen.
3. **YT Channel Spy nach dem ersten Lauf:** 3 Kanäle, 1 wartendes Video, 38
   übersprungene im zugeklappten Block.
4. **Pläne:** 5 laufende Pläne untereinander, jeder mit sechs Themenbereichen.
5. **Artikel-Detail eines Videoartikels:** mit Warnleiste der Wortlaut-Prüfung, Link
   zur Quelle und vier Reitern.
6. **Einstellungen:** sechs Karten, darunter ein Textfeld mit 11.500 Zeichen.
7. **Handy, 390 px:** dieselbe Übersicht und die Artikelliste.
8. **Alles frisch:** keine Website, kein Thema, kein Artikel, kein Schlüssel.
