# Architecture

## High-Level

- `SeatingPlan` und `SeatingPlanVersion` speichern die Layout-Definition.
- `SeatDefinition` ist die normalisierte Sitzbasis für schnelle Queries.
- `SeatState` und `SeatHold` sind eventbezogene Zustände.
- `EventSeatPlanMapping` verbindet Event/Subevent mit Plan und Regeln.

## Reservierungskonflikte

1. Vor Hold werden abgelaufene Holds freigegeben.
2. SeatState-Zeilen werden in Transaktion gelockt (`select_for_update`).
3. Nur `available` darf in `hold` wechseln.
4. Sale-Confirm setzt Hold atomar auf `sold`.

## Auto-Seat

Strategien:
- `strict_adjacent`: Sliding Windows pro Reihe
- `nearby_row_flexible`: Fallback auf direkt benachbarte Reihe
- `best_available`: Bewertete Gruppenkandidaten (Reihe + Distanz + Präferenzen)

## Skalierung

- Indizes auf häufige Filter (`event/subevent/status/expires_at`)
- Potenzielle nächste Schritte:
  - serverseitige Segmentierung nach Block/Viewport
  - inkrementelle Availability-Events
  - Canvas-Hybrid für >10k Seats

