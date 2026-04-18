# Admin Guide

## Rollen und Berechtigungen

- Zugriff auf den Editor nur für Event-Admins/Team mit Event-Backend-Zugriff.
- API-Hold und Auto-Seat sind für Shop-Clients gedacht; zusätzliche Gateway-/Rate-Limits empfohlen.

## Operative Aufgaben

- Hold-Timeout je Event-Mapping konfigurieren.
- Technische Sperrplätze im Plan markieren.
- Bei Änderungen am Plan neue Version speichern.

## Monitoring

- Konflikte über API-Responses `409` überwachen.
- Audit-Log-Einträge für Holds/Bulk-Änderungen regelmäßig prüfen.

## Backup/Restore

- Plan-JSON regelmäßig exportieren.
- Datenbank-Backups müssen `pretix_smartseating_*` Tabellen enthalten.

