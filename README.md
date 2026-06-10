# pretix-smartseating

pretix-Plugin für die **grafische Sitzplanverwaltung**. Der visuelle Editor erzeugt einen
pretix-kompatiblen Sitzplan und veröffentlicht ihn in das **native pretix-Seating**. Damit
übernimmt pretix selbst Verfügbarkeit, Sitz-Holds (über `CartPosition`), Locking, den kompletten
Checkout, den Order-Lifecycle sowie die Anzeige des Sitzplatzes auf Ticket und in der Bestellung.

> Architektur ab 0.3.0: Das Plugin **ersetzt nicht** den pretix-Checkout, sondern speist das
> native Seating. Es gibt damit kein eigenes Hold-/Verkaufs-System und keine anonyme Schreib-API
> mehr — pretix-Core ist die einzige Wahrheit für Verfügbarkeit und Verkauf.

## Features

- **Editor** (pro Organizer wiederverwendbar):
  - **Click-to-Place**: Werkzeug wählen (Reihe, Block, Bogen, Tisch, Bühne, runde Fläche, Label),
    Optionen in der Sidebar einstellen, dann an die gewünschte Stelle im Plan klicken. `Esc` =
    zurück zum Auswahl-Werkzeug; die Sidebar-Buttons platzieren als Fallback in der Mitte.
  - Tisch-Werkzeug (rund/rechteckig) mit **einstellbarer Stuhlanzahl** je Tisch
    („Seats at table"); runde Tische wachsen bei vielen Stühlen automatisch mit
  - Tische und Blöcke werden beim Platzieren **automatisch gruppiert**; Gruppen
    werden mit gestricheltem Rahmen + Namen im Plan angezeigt, ein Klick wählt die
    ganze Gruppe (Alt-Klick = einzelner Sitz), sodass sie als Einheit verschiebbar ist
  - **Gruppe betreten (Photoshop-Stil):** Doppelklick öffnet die Gruppe zum Bearbeiten
    einzelner Sitze (Esc / Klick ausserhalb verlässt sie wieder); der Rahmen folgt den
    Elementen beim Verschieben
  - **Canvas-Grenzen:** Verschieben, Skalieren und Platzieren sind auf die definierte
    Canvas-Größe begrenzt — nichts kann ausserhalb landen
  - Rotations-Anfasser (Fläche oder Mehrfach-Auswahl, Shift = 15°-Raster) + Ausricht-Hilfslinien
  - Sitzreihen-Generator, Bogen-/Halbrund-Generator (Center/Radius/Winkel, mehrere Reihen)
  - Hintergrund-Vorlagen (PNG/JPG/WEBP/GIF/SVG/PDF) als Layer mit Position/Skalierung/Rotation/Opacity
  - Multi-Select (Shift+Click), Duplicate/Delete, Bulk-Block/Unblock, Undo/Redo
  - Pan/Zoom (Mausrad/Drag/Pinch, Doppelklick = einpassen) mit Viewport-Culling: nur sichtbare
    Sitze werden gerendert, Labels ab vielen sichtbaren Sitzen ausgeblendet → große Pläne bleiben flüssig
  - Rechteck-Block-Generator + Bogen/Halbkreis-Generator
  - Flächen & Beschriftungen (Bühne, Bar, runde Flächen, **Polygone**, Textlabels) — wie
    seats.pretix.eu, werden auch im Shop angezeigt
  - **Polygon- & Kurven-Werkzeug**: eigene Flächen per Klick-für-Klick zeichnen
    (Doppelklick/Enter schliesst, Esc bricht ab); die Kurve glättet die Punkte zu Rundungen
  - **Flächen-Rolle (nur Editor)**: jede Fläche/Polygon wahlweise **Interaktiv** (anklick-/
    bearbeitbar) oder **Deko** (gesperrte, klick-durchlässige Markierung); globaler Schalter
    „Deko bearbeiten" zum erneuten Selektieren
  - **Fläche mit Sitzen füllen**: beliebige Fläche auswählen, Anzahl + Kategorie angeben →
    Sitze werden gleichmäßig innerhalb der Form verteilt und gruppiert
  - **Produkt-/Stehplatz-Flächen**: Fläche auf Rolle „Produkt" setzen + pretix-Produkt
    verknüpfen → im Shop klickbare Region, die das Produkt mengenweise (natives `item_<id>`)
    in den Warenkorb legt (keine Einzelsitze; ein nicht-bestuhltes Produkt verwenden)

> 📖 Ausführliche Bedienungsanleitung: [`docs/sitzplan-anleitung.md`](docs/sitzplan-anleitung.md)
> (auch als BookStack-importierbare `docs/sitzplan-anleitung.html`).
  - Kategorie-/Preiszonen-Verwaltung im Editor; Sitz-Eigenschaften (Kategorie, Sitztyp) für die Auswahl
  - Ausrichten & Verteilen mehrerer Sitze
  - Import/Export im plugin-eigenen **und** im seats.pretix.eu-/pretix-nativen JSON-Format
  - Kategorien (Preiszonen) per Farbe, Sitztypen (normal, Rollstuhl, Begleitung, technisch, VIP)
  - JSON Import/Export, Validierung gegen doppelte Sitze/Labels und fehlende Kategorien
- **Standort-Presets**: Plan als Preset speichern und für weitere Events kopieren.
- **Native Veröffentlichung**: „Apply to event" mappt jede Sitzkategorie auf ein pretix-Produkt
  (Item) und erzeugt die `Seat`-Objekte – pro Event oder pro SubEvent.
- **Auto-Seat** über die native Verfügbarkeit: schlägt eine freie Sitzgruppe vor
  (`strict_adjacent`, `nearby_row_flexible`, `best_available`), berücksichtigt laufende
  Carts/Orders/Voucher via `Seat.is_available()`. Read-only GET-Endpunkt
  `…/smartseating/<org>/<event>/autoseat-suggest/`; die Buchung erfolgt über den pretix-Cart.

## Wie der Verkauf funktioniert (nativ)

1. Plan im Editor bauen → **Save**.
2. **Apply to event (sell seats)**: Sitzkategorien → Produkte mappen, optional SubEvent wählen.
3. Das Plugin erzeugt einen nativen `pretixbase.SeatingPlan`, setzt `event.seating_plan`,
   schreibt `SeatCategoryMapping` und ruft `generate_seats()` auf.
4. Ab hier rendert **pretix** die Sitzauswahl im Shop, hält Sitze über `CartPosition.expires`,
   sperrt parallele Zugriffe (`select_for_update`), überträgt sie bei Order-Abschluss und gibt sie
   bei Cancel/Expire/Change frei. Der Sitz erscheint nativ auf Ticket, Bestellung und im Backend.

Erneutes „Apply" ist idempotent: bestehende, bereits verkaufte Sitze sind geschützt
(`SeatProtected`), neue/geänderte Sitze werden aktualisiert.

## Voraussetzungen

- Python **3.11+**
- pretix **2025.10+** (entwickelt/getestet gegen 2026.x, Django 5.2)
- PostgreSQL für Produktion (für Seat-Locking dringend empfohlen)

## Installation

Siehe [INSTALL.md](INSTALL.md). Kurz:

```bash
pip install pretix-smartseating
python -m pretix migrate      # pretix-Core zuerst migrieren, dann das Plugin
python -m pretix rebuild
```

Das Plugin registriert sich über den `pretix.plugin`-Entry-Point automatisch und wird im Event
unter **Einstellungen → Plugins** aktiviert.

## Backend-Verwendung

1. Event öffnen → Navigation **Smart Seating**.
2. Plan erstellen oder aus Preset kopieren.
3. Im Editor Reihen/Sitze erzeugen, Kategorien und Sitztypen setzen, optional Hintergrund hochladen.
4. **Save**, danach **Apply to event** und Kategorien → Produkte mappen.

## Berechtigungen & Sicherheit

- Alle Backend-Views erfordern die Event-Berechtigung `can_change_event_settings`
  (über `event_permission_required`), inkl. Mandantentrennung über `request.organizer`.
- Datei-Uploads sind gehärtet: SVG wird mit `defusedxml` geparst (kein XXE/Entity-Bombing) und
  von Script/Event-Handlern/`javascript:` bereinigt; Rasterbilder werden mit Pillow verifiziert und
  gegen Decompression-Bombs begrenzt; Extension/MIME-Allowlist; JSON-Body-Limit.

## Auto-Seat-Scoring

Gewichtete Kriterien (Service `services/autoseat.py`): Reihen-Kohärenz, direkte Nachbarschaft,
Gruppenstreuung, zentrale/vordere Lage (`prefer_center`/`prefer_front`), Kategorie-Bereich,
bevorzugte Blöcke. Aktuell als Bibliotheksfunktion verfügbar (Frontend-Anbindung an die native
Sitzauswahl ist Roadmap).

## Tests

```bash
pip install -e .[dev]
pytest                # nutzt pretix.testutils.settings (DJANGO_SETTINGS_MODULE)
ruff check . && mypy pretix_smartseating
DJANGO_SETTINGS_MODULE=pretix.testutils.settings python -m django check
```

## Bekannte Einschränkungen (0.3.0)

- Die Sitzauswahl im Shop wird von pretix-Core gerendert (seats.pretix.eu-Frontend); ein eigenes
  mobile-first Selector-Widget ist Roadmap.
- Auto-Seat liefert Vorschläge über einen read-only Endpunkt; das Vorbelegen im pretix-Shop-Frontend
  ist noch nicht automatisch verdrahtet (Frontend-Hook ausstehend).
- Editor-Performance: Ausgelegt auf realistische Größen bis **~5.000 Sitze**. Viewport-Culling +
  Label-Begrenzung sind aktiv (gerendert wird nur der sichtbare Ausschnitt); das initiale Laden des
  Plan-JSON bleibt linear zur Sitzanzahl, ist in diesem Bereich aber unkritisch.

## Dokumentation

- [INSTALL.md](INSTALL.md) · [docs/AUDIT.md](docs/AUDIT.md) ·
  [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) · [CHANGELOG.md](CHANGELOG.md)
- [docs/THEME-INTEGRATION.md](docs/THEME-INTEGRATION.md) (historisch; mit nativer Integration nicht
  mehr erforderlich)

## Lizenz

MIT. Konzepte für den Order-Lifecycle wurden vom Apache-2.0-Plugin
`PierreArchambeau/seatplan` inspiriert (kein Code übernommen).
