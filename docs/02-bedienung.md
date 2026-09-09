# Bedienung

## Die Bereiche der Oberfläche

| Bereich | Wofür |
|---|---|
| **Übersicht** | Stand auf einen Blick: verbundene Websites, veröffentlichte Beiträge, letzte Ereignisse |
| **Websites** | Je Website: Verbindung, redaktionelle Vorgaben, Themenliste, erzeugte Artikel |
| **Posts** | Beiträge erzeugen: einzeln, wiederkehrend oder (später) gezielt nach Keyword-Recherche |
| **Artikel** | Alle erzeugten Beiträge – prüfen, bearbeiten, veröffentlichen |
| **Einstellungen** | API-Key, Modell, Marke, Prompt-Framework, Diagnose-Zugang |
| **Protokoll** | Jede Anfrage und jede Aktion, filterbar |

---

## Eine Website einrichten

Unter **Websites → [Name öffnen]** gibt es vier Reiter:

**Verbindung** – Hub-Adresse und Website-Token zum Kopieren ins Plugin. Hier wird auch festgelegt:

- *Übertragungsweg:* „Hub sendet an WordPress" (Standard) oder „WordPress holt selbst ab".
- *Beitragsstatus:* mit welchem Status Beiträge in WordPress ankommen.
  Zum Start **Entwurf** – dann liest du in WordPress noch einmal drüber.

**Inhalt & Stil** – das Briefing, das in jeden Artikel dieser Website einfließt:
Sprache, Artikellänge, Zielgruppe, Tonalität, Themenschwerpunkte und zusätzliche Anweisungen.

Dort steht auch die **Kategorie**. Das Plugin meldet dem Hub, welche Kategorien es auf der
Website tatsächlich gibt, und genau diese Liste bekommt die KI zur Auswahl vorgelegt.
Standard ist „KI wählt die passendste": Für jeden Beitrag wird die am besten passende
vorhandene Kategorie gewählt. Alternativ legst du eine feste Kategorie für alle Beiträge fest.
**Neue Kategorien werden nie angelegt.** Passt am Ende doch nichts, landet der Beitrag in der
Standardkategorie von WordPress, und am Artikel steht ein Hinweis.

> Je konkreter die Zielgruppe, desto besser die Texte.
> „Einsteiger, die sich gerade ihre erste Espressomaschine gekauft haben" ist deutlich
> nützlicher als „Kaffeeliebhaber".

**Themen** – die Warteliste der Website. Eigene Themen zeilenweise eintragen oder
von der KI zehn Vorschläge erzeugen lassen. Aus jedem Thema lässt sich direkt ein Artikel schreiben.

**Artikel** – alle Beiträge dieser Website.

---

## Posts

### Post erzeugen

Website wählen, Thema eingeben, optional einen Blickwinkel angeben („Schritt-für-Schritt für Einsteiger").
Der Hub schreibt den Artikel im Hintergrund; das dauert je nach Länge ein bis drei Minuten.
Die Seite aktualisiert sich von selbst.

### Wiederkehrende Posts

Ein Plan besteht aus:

- **Website** – wohin die Beiträge gehen
- **Themenbereiche** – eine Zeile je Bereich, z. B. „Kaffeezubereitung zu Hause"
- **Posts pro Woche** – daraus berechnet der Hub den Abstand zwischen zwei Beiträgen
- **Uhrzeit** – bevorzugter Zeitpunkt (Serverzeit, UTC)
- **Automatisch senden** – Haken gesetzt: der fertige Beitrag geht direkt an WordPress.
  Ohne Haken: er bleibt als Entwurf im Hub und wartet auf deine Freigabe.

So arbeitet ein Plan, wenn er fällig ist:

1. Gibt es ein offenes Thema in der Themenliste der Website? Dann wird dieses genommen.
2. Ist die Liste leer, lässt der Hub aus den Themenbereichen fünf neue Themen erzeugen.
3. Aus dem Thema entsteht ein Artikel.
4. Je nach Einstellung geht er direkt an WordPress oder bleibt als Entwurf liegen.

Mit **Jetzt ausführen** lässt sich ein Plan sofort testen, ohne auf den Termin zu warten.
Mit **Pausieren** wird er angehalten, ohne ihn zu löschen.

### Gezielte Posts

Vorbereitet für die nächste Ausbaustufe: Posts gezielt auf recherchierte Suchbegriffe ansetzen –
mit Suchvolumen, Analyse der führenden Ergebnisse und daraus abgeleiteter Gliederung.
Siehe [Roadmap](05-roadmap.md).

---

## Artikel prüfen und veröffentlichen

Jeder Artikel hat drei Reiter:

- **Vorschau** – so wird der Beitrag aussehen
- **Bearbeiten** – Titel, Anreißer und der Text als HTML
- **SEO** – Slug, Kategorie, Schlagwörter, SEO-Titel und -Beschreibung
- **Bilder** – die erzeugten Bilder mit Alt-Text, Unterschrift und Bildbeschreibung.
  Über *Bilder neu erzeugen* entstehen zu denselben Konzepten neue Bilder

**An WordPress senden** überträgt den Beitrag. Er erscheint dort mit dem Status,
der für die Website eingestellt ist. **Neu schreiben** erzeugt zum selben Thema
einen frischen Artikel, der alte bleibt erhalten.

**Alles bleibt im Panel gespeichert.** Der vollständige Text, die SEO-Felder und die Bilder
liegen weiter im Hub, auch nachdem der Beitrag in WordPress angekommen ist. Damit die Arbeitsliste
übersichtlich bleibt, wandert ein Beitrag nach der erfolgreichen Übergabe automatisch ins **Archiv**.

Unter **Artikel** gibt es dafür zwei Ansichten: **In Arbeit** zeigt alles, was noch Aufmerksamkeit
braucht, **Archiv** alles Erledigte. Über *Archivieren* und *Aus dem Archiv holen* lässt sich das
jederzeit von Hand ändern, zum Beispiel wenn ein Beitrag doch noch überarbeitet werden soll.

Statusbedeutungen:

| Status | Bedeutung |
|---|---|
| wird erzeugt | Die KI schreibt gerade |
| Entwurf | Fertig, liegt im Hub |
| wird übertragen | Unterwegs zu WordPress (im Abholmodus: wartet auf das Plugin) |
| veröffentlicht | In WordPress angelegt |
| Fehler | Etwas ging schief – die Ursache steht direkt am Artikel und im Protokoll |

---

## Einstellungen

**Anthropic API-Key** – ohne ihn kann nichts erzeugt werden. Verschlüsselt gespeichert.

**Modell**

| Modell | Wann |
|---|---|
| Claude Opus 5 | Beste Textqualität – Standard |
| Claude Sonnet 5 | Schneller und günstiger, sehr gute Qualität |
| Claude Haiku 4.5 | Am günstigsten, für einfache Themen und große Mengen |

**Sorgfalt** steuert, wie gründlich das Modell arbeitet. „hoch" ist der Standard,
„sehr hoch" bringt bei anspruchsvollen Fachthemen noch etwas mehr, kostet aber mehr Token.

**Marke & Standardvorgaben** gelten für alle Websites, sofern eine Website nichts Eigenes vorgibt.

**Prompt-Framework** – das Regelwerk, nach dem geschrieben wird: Inhalt, Struktur, SEO, erlaubtes HTML.
Der Hub ergänzt automatisch das Briefing der jeweiligen Website und das konkrete Thema –
dieses Regelwerk bestimmt das *Wie*. Mit **Standard wiederherstellen** kommt jederzeit die
mitgelieferte Fassung zurück.

Zwei Regeln sind fest eingebaut, damit sie nicht durchrutschen: Der lange Gedankenstrich „—"
wird nach der Erzeugung auch im Code entfernt (je nach Stelle wird daraus ein Komma oder ein
Bindestrich), und das Artikel-HTML wird gegen eine Positivliste erlaubter Tags geprüft.
Der normale Bindestrich bleibt davon unberührt.

Ein paar Beispiele, die sich bewährt haben:

```
- Beginne nie mit "In der heutigen Zeit" oder "Immer mehr Menschen".
- Baue in jeden Artikel eine konkrete Handlungsanweisung mit Schritten ein.
- Nenne bei Produkten nie Preise, sie veralten zu schnell.
- Schreibe geschlechtsneutral.
```

**Bilder** – Claude selbst erzeugt keine Bilder. Der Hub spricht dafür einen Bilddienst an,
der die OpenAI-Bildschnittstelle versteht (Standard: `https://api.openai.com/v1`, Modell `gpt-image-1`;
jeder kompatible Dienst funktioniert). Einzustellen sind Schlüssel, Modell, Format, Qualität,
Anzahl der Bilder je Artikel (0 bis 4) und ein **Bildstil**, der an jede Bildbeschreibung angehängt wird
und den Look über alle Artikel gleich hält.

So läuft es ab: Beim Schreiben liefert Claude neben dem Text auch Bildkonzepte mit
englischer Bildbeschreibung, Alt-Text und Bildunterschrift. Bild 1 ist immer das Beitragsbild,
weitere Bilder setzt Claude als Platzhalter `[[BILD:2]]` an die passende Stelle im Text.
Der Hub erzeugt die Bilder und zeigt sie im Artikel unter **Bilder**. Beim Veröffentlichen lädt
das WordPress-Plugin sie in die Mediathek, setzt das Beitragsbild und ersetzt die Platzhalter
durch das Bild samt Unterschrift. Platzhalter ohne Bild verschwinden rückstandslos.

> Wichtig: Damit WordPress die Bilder abholen kann, muss `PUBLIC_URL` gesetzt und der Hub
> **von der WordPress-Seite aus** erreichbar sein, nicht nur von deinem Browser. Klappt das nicht,
> wird der Beitrag trotzdem angelegt, und am Artikel steht ein gelber Hinweis mit der genauen
> Fehlermeldung aus WordPress, etwa „Bild 1: Hub nicht erreichbar (Connection refused)".
> Läuft der Hub auf einem eigenen Port wie 4000, muss der WordPress-Hoster ausgehende
> Verbindungen dorthin zulassen.

**Diagnose-Zugang** – siehe [Diagnose](03-diagnose.md).
