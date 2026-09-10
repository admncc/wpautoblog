=== Autoblog Connector ===
Contributors: autoblog
Tags: automation, blogging, ai, content
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Verbindet diese WordPress-Seite mit dem Autoblog Hub. Der Hub erzeugt Blogartikel und legt sie hier als Beitrag an.

== Description ==

Der Autoblog Connector ist die WordPress-Seite eines zweiteiligen Systems:

* Der **Autoblog Hub** (eigene Weboberflaeche) plant und erzeugt die Artikel.
* Dieses **Plugin** empfaengt die fertigen Artikel und legt sie als Beitrag an.

Es gibt zwei Uebertragungswege, umschaltbar im Hub:

1. **Der Hub sendet** an diese Website (Standard). Voraussetzung: Die Website ist aus dem Internet erreichbar.
2. **WordPress holt ab.** Ein WP-Cron-Auftrag fragt alle 15 Minuten beim Hub nach wartenden Artikeln.
   Geeignet fuer Installationen hinter einer Firewall oder im Aufbau.

Sicherheit: Jede Uebertragung wird mit HMAC-SHA256 signiert und traegt einen Zeitstempel,
der maximal fuenf Minuten alt sein darf. Ohne gueltige Signatur wird jede Anfrage abgewiesen.
Es werden keine Passwoerter und keine WordPress-Anwendungspasswoerter uebertragen.

== Installation ==

1. Ordner `autoblog-connector` nach `wp-content/plugins/` hochladen (oder ZIP ueber "Plugins -> Installieren" einspielen).
2. Plugin aktivieren.
3. Im Autoblog Hub die Website anlegen und den Website-Token kopieren.
4. In WordPress unter "Einstellungen -> Autoblog" die Hub-Adresse und den Token eintragen und auf "Verbinden" klicken.

== Frequently Asked Questions ==

= Werden Beitraege sofort veroeffentlicht? =

Nein, das steuerst du im Hub. Standard ist "Entwurf" - die Beitraege warten dann in WordPress auf deine Freigabe.

= Wo landen die SEO-Angaben? =

Titel und Beschreibung werden in eigenen Feldern gespeichert und zusaetzlich, falls vorhanden,
in die Felder von Yoast SEO oder Rank Math geschrieben.

= Wie wird das Plugin aktualisiert? =

Vom Hub. Der Hub haelt immer das Archiv bereit, das zu seinem eigenen Stand passt.
Das Plugin fragt regelmaessig nach und meldet ein Update unter "Plugins" wie jedes andere.
Mit dem Haken "Automatische Updates" spielt WordPress es selbstaendig ein. Zusaetzlich laesst
sich das Update im Hub per Knopfdruck fuer jede Website ausloesen.

= Was passiert, wenn der Token neu erzeugt wird? =

Die alte Verbindung wird sofort ungueltig. Trage den neuen Token unter "Einstellungen -> Autoblog" ein.

== Changelog ==

= 1.4.0 =
* Beitraege aus Videos: Das Quellvideo wird oben eingebettet und unten als Quelle genannt.

= 1.3.0 =
* Updates kommen jetzt direkt vom Autoblog Hub: Sie erscheinen unter "Plugins" wie gewohnt,
  lassen sich automatisch einspielen und koennen vom Hub aus angestossen werden.

= 1.2.0 =
* Kategorien: Die Website meldet ihre vorhandenen Kategorien an den Hub. Der Beitrag wird
  ausschliesslich einer davon zugeordnet, es wird nie eine neue angelegt.

= 1.1.0 =
* Bildimport ohne media_sideload_image, damit der Hub auch auf einem eigenen Port erreichbar ist.
* Fehlgeschlagene Bilder werden mit Grund an den Hub zurueckgemeldet statt uebersprungen.

= 1.0.0 =
* Erste Fassung: Verbindung per Website-Token, signierte Uebertragung, Sende- und Abholmodus,
  Kategorien, Schlagwoerter, SEO-Felder und Autorenzuweisung.
* Bilder: Import in die Mediathek, Beitragsbild und Platzierung im Text ueber Platzhalter.
