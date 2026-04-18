# API Reference

## GET `/api/v1/{organizer}/{event}/seatplan/`

Liefert Planmetadaten, Kategorien und Sitzdefinitionen.

## GET `/api/v1/{organizer}/{event}/availability/`

Liefert Sitzstatus je Sitz (`available`, `hold`, `sold`, `blocked`, `technical`).

## POST `/api/v1/{organizer}/{event}/hold/`

Body:

```json
{ "seat_ids": [1, 2], "customer_ref": "session-123" }
```

Antwort enthält Token, gehaltene und abgelehnte Sitze.

## POST `/api/v1/{organizer}/{event}/release-hold/`

Body:

```json
{ "token": "uuid" }
```

## POST `/api/v1/{organizer}/{event}/autoseat/`

Body:

```json
{ "quantity": 3, "mode": "nearby_row_flexible", "category": "standard" }
```

Erzeugt Hold auf den gefundenen Sitzen.

## POST `/api/v1/{organizer}/{event}/confirm-sale/`

Body:

```json
{ "token": "uuid", "order_code": "ABCD1" }
```

Konvertiert Hold-Sitze in `sold`.

