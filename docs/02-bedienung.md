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

**An WordPress senden** überträgt den Beitrag. Er erscheint dort mit dem Status,
der für die Website eingestellt ist. **Neu schreiben** erzeugt zum selben Thema
einen frischen Artikel, der alte bleibt erhalten.

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

Ein paar Beispiele, die sich bewährt haben:

```
- Beginne nie mit "In der heutigen Zeit" oder "Immer mehr Menschen".
- Baue in jeden Artikel eine konkrete Handlungsanweisung mit Schritten ein.
- Nenne bei Produkten nie Preise, sie veralten zu schnell.
- Schreibe geschlechtsneutral.
```

**Diagnose-Zugang** – siehe [Diagnose](03-diagnose.md).
