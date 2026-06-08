# Installation Guide

## Voraussetzungen

- Python **3.11+**
- pretix **2025.10+** (getestet gegen 2026.x / Django 5.2)
- PostgreSQL für Produktion (für natives Seat-Locking empfohlen)

## 1. Plugin installieren

```bash
pip install pretix-smartseating
```

Alternativ lokal im Development:

```bash
pip install -e .[dev]
```

Eine separate `INSTALLED_APPS`-Anpassung ist **nicht** nötig: Das Plugin registriert sich über den
`pretix.plugin`-Entry-Point. Aktivierung erfolgt pro Event unter **Einstellungen → Plugins**.

## 2. Migrationen

pretix-Core muss vollständig migriert sein, **bevor** das Plugin migriert (Standard-Installations-
Flow). Anschließend:

```bash
python -m pretix migrate
python -m pretix rebuild
```

## 3. Deployment

```bash
python -m pretix collectstatic
```

Web- und Worker-Prozesse neu starten.

## 4. Erstkonfiguration

1. Event öffnen, unter **Einstellungen → Plugins** „Smart Seating" aktivieren.
2. Navigation **Smart Seating** öffnen.
3. Sitzplan anlegen (oder aus Preset kopieren).
4. Im Editor Reihen/Sitze erzeugen, Kategorien setzen, **Save**.
5. **Apply to event (sell seats)**: jede Sitzkategorie einem Produkt zuordnen, optional SubEvent
   wählen, anwenden.
6. Fertig — pretix rendert die Sitzauswahl im Shop und verwaltet Holds, Checkout und Tickets nativ.

## Troubleshooting

- **`NodeNotFoundError` / `pretixbase` bei `migrate`**: pretix-Core zuerst migrieren.
- **„Apply" meldet `SeatProtected`**: Ein bereits verkaufter Sitz fehlt im neuen Plan. Sitz im
  Editor behalten oder die betroffene Bestellung stornieren, dann erneut anwenden.
- **Keine Sitzauswahl im Shop**: Prüfen, ob `event.seating_plan` gesetzt ist (über „Apply") und ob
  mindestens eine Kategorie auf ein aktives Produkt gemappt wurde.
- **Upload abgelehnt**: Erlaubte Typen sind PNG/JPG/WEBP/GIF/SVG/PDF; SVG wird sanitisiert,
  zu große Bilder werden abgewiesen.
