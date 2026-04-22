# pretix-smartseating

Produktionsreifes pretix-Plugin für Saalpläne und reservierte Sitzplätze mit visuellem Editor, Sitzplatzwahl im Shop, Hold/Locking und Auto-Seat-Algorithmen.

## Features

- Backend-Sitzplanverwaltung pro Organizer/Event
- Grafischer Editor (SVG) mit:
  - Sitzreihen-Generator
  - Bogen- und Halbrund-Generator (Center/Radius/Winkel, mehrere Reihen auf einmal)
  - Hintergrund-Vorlagen (PNG/JPG/SVG/PDF) als Layer
  - Layer-Controls (sichtbar, gesperrt, Position, Skalierung, Rotation, Opacity, Z-Index)
  - Multi-Select (Shift+Click)
  - Delete/Duplicate für Auswahl + Tastatur-Shortcuts
  - Bulk-Block/Unblock
  - Undo/Redo
  - JSON Import/Export
- Standort-Presets:
  - Plan als Preset speichern
  - neuen Event-Plan aus Preset erzeugen
  - erzeugte Pläne bleiben voll editierbar
- Shop-Sitzplatzauswahl:
  - interaktive Seatmap
  - klare Statusfarben (frei, hold, verkauft, blockiert)
  - periodischer Availability-Refresh
  - Keyboard/ARIA-Basics
- Auto-Seat-Modi:
  - `strict_adjacent`
  - `nearby_row_flexible`
  - `best_available`
- Sitz-Hold mit Ablaufzeit und Konfliktbehandlung
- Audit-Log-Grundlage
- API-Endpunkte für Plan, Verfügbarkeit, Holds, Auto-Seat
- Tests für Validierung, Import/Export, Auto-Seat, API-Fehlerfälle

## Architekturüberblick

- Backend: Django + pretix Plugin-API
- Editor/Shop-Rendering: SVG
- State im Editor: in-memory JSON, Snapshot-basierte Undo/Redo-Stacks
- Datenhaltung: normalisierte Modelle + versioniertes Layout-JSON

Warum SVG:
- präzise Seat-Interaktion, gute Accessibility und einfaches Selektionsverhalten.
- Für sehr große Pläne ist Hybrid später vorgesehen (Viewport-Culling + optional Canvas-Layer).

Konfliktvermeidung:
- Sitz-Holds laufen über atomare Transaktionen und `select_for_update`.
- Ablauf von Holds wird vor kritischen Schreiboperationen aktiv bereinigt.

## Projektstruktur

```text
pretix_smartseating/
  migrations/
  services/
  static/
  templates/
tests/
docs/
assets/screenshots/
```

## Voraussetzungen

- Python 3.10+
- pretix 2025.1+
- PostgreSQL (empfohlen für Produktion)

## Installation

Siehe [INSTALL.md](INSTALL.md).

Kurz:

```bash
pip install pretix-smartseating
```

Dann in pretix:

```python
INSTALLED_APPS += ["pretix_smartseating"]
```

Migrationen ausführen:

```bash
python -m pretix migrate
python -m pretix rebuild
```

## Backend-Verwendung

1. Event öffnen
2. Navigation `Smart Seating`
3. Plan erstellen
4. Im Editor Reihen und Sitze erzeugen
5. Für runde Reihung: `Generate arc row` oder `Generate semicircle rows` nutzen
6. Radius/Winkel/Reihenabstand setzen und mit einem Klick generieren
7. Optional: Bild/PDF als Hintergrundvorlage hochladen und Layer justieren
8. Speichern und optional JSON exportieren/importieren
9. Optional: Plan als Preset speichern, um ihn für weitere Events wiederzuverwenden

## Frontend-Verwendung

- Einbindung über Template-Snippet [seat_selector.html](/C:/Users/<user>/Documents/pretix-smartseat/pretix_smartseating/templates/pretix_smartseating/shop/seat_selector.html)
- Konkrete Theme-Override-Anleitung: [docs/THEME-INTEGRATION.md](docs/THEME-INTEGRATION.md)
- Modi:
  - Manuell
  - Auto-Seat (strict/nearby/best)

## Auto-Seat-Scoring (parametrierbar)

Gewichtete Kriterien:
- Reihen-Kohärenz (gleiche Reihe Bonus)
- direkte Nachbarschaft Bonus
- Gruppenstreuung Malus (Distanz)
- zentrale Lage Bonus (`prefer_center`)
- vordere Lage Bonus (`prefer_front`)
- gleicher Kategorie-Bereich Bonus
- bevorzugte Blöcke Bonus

## API-Endpunkte

- `GET /api/v1/{organizer}/{event}/seatplan/`
- `GET /api/v1/{organizer}/{event}/availability/`
- `POST /api/v1/{organizer}/{event}/hold/`
- `POST /api/v1/{organizer}/{event}/release-hold/`
- `POST /api/v1/{organizer}/{event}/autoseat/`
- `POST /api/v1/{organizer}/{event}/confirm-sale/`

## Performance

- DB-Indizes auf Sitzidentität, Statusabfragen und Hold-Expiry
- periodische Hold-Bereinigung
- Auto-Seat-Kandidatensuche mit heuristischer Begrenzung
- vorgesehen: Viewport-Culling und serverseitige segmentierte Availability für sehr große Pläne

## Accessibility

- Tastaturauswahl im Shop (Enter/Space)
- ARIA-Label je Sitz
- farbliche Legende + klare Zustände

## Entwicklung

Siehe [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md).

## Tests

```bash
pytest
```

## Release-Prozess

- SemVer
- Initiale Version: `0.1.0`
- Changelog: Keep a Changelog in [CHANGELOG.md](CHANGELOG.md)
- Tag-Beispiel: `v0.1.0`

## Roadmap

- Sichtlinien/Obstructions
- CSV-Import mit Mapping-Profilen
- erweiterter Canvas-Hybrid für 10k+ Sitze
- fortgeschrittene Preiszonen und Quotenintegration

## Bekannte Einschränkungen (0.1.0)

- Editor ist in dieser Version bewusst fokussiert (Row-Generator + Bulk-Editing), noch ohne freie Polygonflächen.
- Shop-Widget ist als Snippet implementiert und muss in das gewünschte Theme eingebunden werden.

## Sicherheitshinweise

- Alle Hold-/Sale-Schritte müssen über die API mit atomaren Operationen laufen.
- Direkte Schreibzugriffe ohne Berechtigungs- und Zustandsprüfung vermeiden.
- Importdaten werden validiert (Duplikate, Kategorien, Bounds).
