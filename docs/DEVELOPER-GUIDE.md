# Developer Guide

## Setup

```bash
pip install -e .[dev]
```

## Quality Checks

```bash
ruff check .
mypy pretix_smartseating
pytest
```

## Wichtige Module

- `pretix_smartseating/models.py`: Domänenmodell
- `pretix_smartseating/services/autoseat.py`: Algorithmik
- `pretix_smartseating/services/holds.py`: Locking/Holds
- `pretix_smartseating/views_api.py`: API
- `pretix_smartseating/static/pretix_smartseating/js/`: Editor + Shop-UI

## Editor-State

- JSON-State wird clientseitig gehalten.
- `undoStack`/`redoStack` als Snapshot-Historie.
- Persistenz via `/save/` Endpoint als kompletter Plan-Import.

## Migration Strategy

- Neue seat- oder state-relevante Felder immer additiv einführen.
- Backfill-Skripte für große Pläne als `RunPython` Migrationen kapseln.

