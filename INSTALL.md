# Installation Guide

## 1. Plugin installieren

```bash
pip install pretix-smartseating
```

Alternativ lokal im Development:

```bash
pip install -e .[dev]
```

## 2. In pretix aktivieren

In deiner pretix-Konfiguration:

```python
INSTALLED_APPS += ["pretix_smartseating"]
```

## 3. Migrationen

```bash
python -m pretix migrate
python -m pretix rebuild
```

## 4. Deployment

```bash
python -m pretix collectstatic
```

Web- und Worker-Prozesse neu starten.

## 5. Erstkonfiguration

1. Event öffnen
2. `Smart Seating` im Event-Backend öffnen
3. Seating Plan anlegen
4. Sitze generieren und speichern
5. Shop-Template um Seat-Selector-Snippet ergänzen

