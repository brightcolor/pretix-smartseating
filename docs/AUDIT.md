# pretix-smartseating — Kompatibilitäts- und Architektur-Audit

> Stand: 2026-06-08 · geprüfte Plugin-Version: `0.2.0` · Branch: `feat/production-readiness`
> Referenz-pretix: **2026.5.0** (PyPI) — `requires-python >=3.11`, Django **5.2**, Python 3.11–3.14
> Referenz-Plugin: `PierreArchambeau/seatplan` (Apache-2.0, nur als Konzeptquelle)

---

## 1. Kurzfazit

**Einsatzfähig: NEIN.**

Das Plugin installiert sich vermutlich und bringt einen brauchbaren Editor-Kern, saubere Models
für Layout/Versionierung und eine durchdachte Autoseat-Logik mit. Es ist aber **kein** in pretix
integriertes Verkaufs-Plugin, sondern ein eigenständiges Sitz-Hold-System, das per
**Theme-Template-Override** in die Presale-Ansicht eingehängt werden muss und dessen Verkäufe
ausschließlich über eine **Staff-only `confirm-sale`-API** laufen, die nichts mit echten
pretix-Orders zu tun hat. Hinzu kommen **mehrere schwere Sicherheitslücken**: anonyme,
CSRF-befreite Schreib-Endpunkte (DoS möglich) und Control-Views ohne Event-Permissions
(mandantenübergreifender Zugriff/IDOR).

Bis zur Behebung der unten gelisteten **Blocker** darf das Plugin nicht produktiv eingesetzt
werden.

---

## 2. Blocker (verhindern Produktivbetrieb)

### B1 — Keine pretix-native Checkout-Integration
`signals.py` verdrahtet ausschließlich `pretix.control.signals.nav_event`. **Keines** der für
einen echten Verkauf nötigen Signale ist angebunden:
`validate_cart`, `validate_order`, `order_placed`, `order_canceled`, `order_expired`,
`order_changed`, `periodic_task`, `pretix.presale.signals.html_head` /
`checkout_flow_steps` / `question_form_fields`.
Folge: Ein im Shop gewählter/gehaltener Sitz wird **nie** an eine pretix-`Order`/`OrderPosition`
gebunden. Der einzige „Verkauf" erfolgt über `views_api.api_confirm_sale` (Staff-API), die einen
`SeatState` per Hold-Token auf `SOLD` setzt und einen **freitextlichen** `order_code` schreibt.
Die Shop-Einbindung erfolgt laut `docs/THEME-INTEGRATION.md` über einen **Theme-Override**
(`{% smartseating_selector %}` in `checkout_questions.html`) — also genau der unerwünschte
Theme-Hack.
*Dateien:* `signals.py`, `views_api.py:231-264`, `templatetags/smartseating_tags.py`,
`templates/.../shop/seat_selector.html`, `docs/THEME-INTEGRATION.md`.

### B2 — Anonyme, CSRF-befreite Schreib-API ohne Bindung
`api_hold`, `api_release_hold`, `api_autoseat` sind `@csrf_exempt`, **ohne jede
Authentifizierung**, und unter öffentlichen URLs `api/v1/<org>/<event>/…` gemountet
(`urls.py:68-85`). Holds werden nur an einen freien String `customer_ref` gebunden — **nicht** an
Session/Cart/Position. Damit kann ein anonymer Client:
- beliebig viele Sitze halten → **trivialer DoS** (gesamten Plan blockieren),
- fremde Holds nicht freigeben (Token nötig), aber den Plan dauerhaft sperren,
- CSRF ist deaktiviert (für anonyme GET-zu-POST-Angriffe relevant, sobald Sessions/Cookies ins Spiel kommen).
*Dateien:* `views_api.py:106-228`, `urls.py:68-85`.

### B3 — Control-Views ohne Event-Permissions (IDOR / Mandantentrennung)
Alle Backend-Views in `views_control.py` sind nur mit `@login_required` geschützt und ermitteln
das Event per Slug aus der URL (`_event_from_url`, `views_control.py:30-31`). Es findet **keine**
Prüfung statt, ob der eingeloggte Nutzer Rechte an diesem Organizer/Event hat. Damit kann **jeder
eingeloggte Backend-Benutzer** Sitzpläne, Presets und Uploads **beliebiger** Events lesen, ändern,
importieren und löschen (`plan_save_layout`, `plan_import`, `plan_template_asset_*`). Das ist eine
horizontale Privilege-Escalation / IDOR.
Korrekt wäre `@event_permission_required("can_change_event_settings")` (pretix) bzw.
`request.user.has_event_permission(...)` wie im Referenz-Plugin.
*Dateien:* gesamtes `views_control.py`.

### B4 — Veraltete/nicht-konforme Plugin-Registrierung
- `__init__.py:1` setzt `default_app_config` — in **Django 4.1 entfernt** (pretix nutzt Django 5.2);
  wirkungslos.
- `apps.py` leitet von `django.apps.AppConfig` ab statt von `pretix.base.plugins.PluginConfig`,
  setzt **kein** `default = True`.
- `PretixPluginMeta` fehlen `level`, `settings_links`, `navigation_links`.
- Entry-Point `pretix_smartseating = "pretix_smartseating:PretixPluginMeta"` zeigt auf ein
  Attribut, das auf Modulebene **nicht existiert** (es ist nur als verschachtelte Klasse in
  `PluginApp` vorhanden). Funktioniert aktuell nur **zufällig**, weil pretix `PretixPluginMeta`
  über `apps.get_app_configs()` von der AppConfig liest und den `:`-Teil des Entry-Points ignoriert.
  Sobald Django die AppConfig nicht eindeutig auto-detektiert, bricht das.
*Dateien:* `__init__.py`, `apps.py`, `pyproject.toml:36-37`.

### B5 — Falsche Python-Untergrenze
`pyproject.toml:10` `requires-python = ">=3.10"`, `tool.ruff.target-version = "py310"`,
`tool.mypy.python_version = "3.10"`. pretix 2026.x verlangt **Python ≥ 3.11**. Das Plugin
deklariert Unterstützung, die es nicht halten kann.
*Dateien:* `pyproject.toml:10,53,56`.

---

## 3. Hohe Risiken

### H1 — Kein DB-Mapping zu Item/Variation/Quota/Order
`SeatCategory` hat nur `price_rank` (Integer), **keine** FK zu `Item`/`ItemVariation`/`Quota`.
`SeatState.order_code` ist ein freier String, **keine** FK zu `Order`/`OrderPosition`.
→ Preiszonen-/Variations-Matching (Kategorie ⇄ Ticket-Typ) ist datenmodellseitig unmöglich;
Order-Integrität (Cancel/Expire/Change) kann nicht zuverlässig nachvollzogen werden.
*Dateien:* `models.py:60-72` (SeatCategory), `models.py:226-253` (SeatState).

### H2 — Doppelte Wahrheitsquelle für Holds
Holds werden **gleichzeitig** in `SeatState` (`status`, `hold_token`, `expires_at`) **und** in der
Tabelle `SeatHold` geführt. `release_hold` löscht `SeatHold` + setzt `SeatState` zurück,
`api_confirm_sale` aktualisiert aber **nur** `SeatState` und lässt `SeatHold`-Zeilen stehen →
Drift/Leichen. Eine der beiden Quellen sollte führend sein.
*Dateien:* `models.py:226-279`, `services/holds.py`, `views_api.py:231-264`.

### H3 — Race Conditions bei Hold-Erstellung
In `create_hold` (`services/holds.py:54-95`) wird pro Sitz
`SeatState.objects.select_for_update().filter(...).first()` aufgerufen. Existiert die `SeatState`-
Zeile noch nicht, sperrt `select_for_update` **nichts**; die Korrektheit hängt allein am
Unique-Constraint + `get_or_create`-IntegrityError-Retry. Das ist fragil und nicht für SubEvents
vor-materialisiert. Zudem liefert `create_hold` **Teil-Holds** als Erfolg zurück (Token + Rest in
`rejected_seat_ids`) — UX-seitig nicht sauber behandelt (siehe M5).
*Dateien:* `services/holds.py:39-95`, `models.py:332-344`.

### H4 — Unsichere Datei-/SVG-/XML-/PDF-Verarbeitung
- `ElementTree.fromstring(content)` auf hochgeladenem SVG (`views_control.py:144`) → anfällig für
  **XXE / Billion-Laughs** (stdlib-XML ohne Schutz). `defusedxml` nötig.
- SVG wird **roh** gespeichert und über die Media-URL ausgeliefert (`image.url`) → potenzielles
  **stored XSS**, wenn das SVG direkt/als `object`/`iframe` gerendert wird. Keine SVG-Sanitisierung.
- `PIL.Image.open` auf untrusted Bildern ohne `Image.MAX_IMAGE_PIXELS`-Schranke → **Decompression-
  Bomb**.
- MIME-Prüfung vertraut Client-`content_type` + Dateiendung (`views_control.py:377,393`), keine
  echte Inhaltsprüfung.
*Dateien:* `views_control.py:138-185, 359-412`.

### H5 — Tests prüfen weder DB noch pretix
- Es gibt **kein** `conftest.py` und **kein** `DJANGO_SETTINGS_MODULE` → Tests, die Models
  importieren (`test_models.py`, `test_import_export.py`), brechen bei der Collection
  (`ImproperlyConfigured`). Die „grüne CI" testet faktisch nur reine Python-Logik
  (Autoseat/Validation) mit `SimpleNamespace`-Mocks.
- `python -m pretix check` läuft **nicht** in der CI.
- Keine Transaktions-/Hold-/Order-/Permission-/Upload-Tests.
- `tests/test_api.py` enthält gar keine API-Tests, sondern Autoseat-Tests (Fehlbenennung).
*Dateien:* `tests/`, `.github/workflows/ci.yml`, `pyproject.toml:45-49`.

---

## 4. Mittlere Risiken

- **M1 — Packaging/i18n:** Build nutzt reines `setuptools`, nicht `pretix-plugin-build`. Folge:
  `.po` → `.mo` wird beim Build **nicht** kompiliert (Übersetzungen de/en greifen im gebauten
  Paket nicht), kein Asset-Build/-Minify, fehlender `distutils.commands`-Build-Entry.
  *Dateien:* `pyproject.toml:1-3,36-43`.
- **M2 — Django-Pin:** `Django>=4.2` direkt in `dependencies` (`pyproject.toml:23`). Django-Version
  sollte pretix vorgeben; eigener Pin riskiert Resolver-Konflikte. Entfernen/anpassen.
- **M3 — Cleanup nur im Request-Pfad:** `release_expired` wird nur in API-GET/POST aufgerufen. Ohne
  `periodic_task`-Receiver bleiben abgelaufene Holds bei fehlendem Traffic liegen.
- **M4 — Frontend ungeprüft:** Editor (547 Zeilen Vanilla-JS) und Shop (138 Zeilen) sind bzgl.
  Mobile/Touch/Performance/A11y nicht verifiziert. Keine Virtualisierung/Viewport-Culling für große
  Pläne (Ziel 10k Sitze).
- **M5 — Autoseat/Hold-Semantik:** `api_autoseat` umschließt das bereits `@transaction.atomic`
  dekorierte `create_hold` erneut mit `transaction.atomic` (redundant). Teil-Hold-Semantik im Shop
  unklar — Adjazenz-Garantie kann durch Teil-Hold verletzt werden.
- **M6 — Eigene Event-Lookups:** Überall `get_object_or_404(Event, …)` statt des von pretix
  bereitgestellten `request.event`/`request.organizer` → umgeht pretix-Scoping und Multidomain-
  Reverse (`eventreverse`).
- **M7 — Scope-Klarheit:** `SeatingPlan.scope_organizer` ist nullable; Pläne ohne Organizer sind
  potenziell „herrenlos" referenzierbar. Event- vs. Organizer-Eigentum unscharf.

---

## 5. Kosmetische Punkte

- **C1** — `tests/test_api.py` ist falsch benannt (enthält Autoseat-Tests).
- **C2** — `nav_event`-Icon `"chair"` existiert in FontAwesome-Sets ggf. nicht → leeres Icon.
- **C3** — Version doppelt gepflegt (`pyproject.toml` + `apps.py`); sollte aus `__version__` abgeleitet werden.
- **C4** — README/INSTALL bewerben „production-ready" — derzeit überzogen.
- **C5** — `_event_context`/`_mapping` werfen blankes `DoesNotExist` (HTTP 500) statt sauberem 404-JSON.

---

## 6. Erkenntnisse aus dem Referenz-Plugin (`seatplan`, Apache-2.0)

**Lizenz:** Apache-2.0 → konzeptkompatibel mit MIT; bei wörtlicher Code-Übernahme Attribution/NOTICE nötig. Wir übernehmen nur **Konzepte**.

**Sinnvoll (übernehmen):**
- `pretix.presale.signals.html_head` zum Injizieren von CSS/JS **ohne Theme-Override** — genau der
  fehlende Baustein in smartseating.
- `validate_cart` / `validate_order` für Sitz-Pflicht und Kategorie⇄Variation-Prüfung.
- `order_placed`: Hold → Assignment, Sitzlabel in `OrderPosition.meta_info` schreiben.
- `order_canceled` / `order_expired`: Assignment freigeben.
- `periodic_task`: abgelaufene Holds global aufräumen.
- `order_position_meta_display` (mit `try/except ImportError`) für Sitzanzeige auf Ticket/Bestellung.
- `request.user.has_event_permission(org, event, 'can_change_settings')` als Permission-Gate.
- Bindung des Holds an die **CartPosition** (der in smartseating fehlende Link).

**Gefährlich/unsauber (NICHT übernehmen):**
- `mark_safe(f"…")` mit String-Interpolation.
- SVG als rohes `TextField`, ungesäubert in die Seite injiziert (XSS).
- **Greedy/Fuzzy-Seat-Matching** in `validate_order` (Fallback „irgendein freier Hold") und Matching
  per Label-String → kann falsche Sitze zuweisen, race-anfällig.
- `cart_position_id` als loses `IntegerField` mit `!= 0`-Sentinel statt FK.
- `periodic_task` iteriert **alle** Events pro Tick → skaliert nicht.
- Kein `select_for_update`/Locking → Race Conditions.

**Fazit Referenz:** Das Signal-/Lifecycle-Gerüst ist vorbildlich und genau das, was smartseating
fehlt; die Datenintegrität (FKs, Locking, deterministisches Matching) ist es nicht. Wir übernehmen
das **Signal-Konzept**, lösen Bindung/Locking aber sauber mit FKs und `select_for_update`.

---

## 7. Konkrete ToDo-Liste (priorisiert)

**Phase 3a — Kompatibilitätsblocker**
1. `__init__.py`: `default_app_config` entfernen, nur `__version__` belassen.
2. `apps.py`: von `pretix.base.plugins.PluginConfig` ableiten, `default = True`,
   `PretixPluginMeta` um `level`, `settings_links`, `navigation_links` ergänzen, `compatibility`
   auf `pretix>=2025.10` o. ä. setzen, `version` aus `__version__`.
3. `pyproject.toml`: `requires-python = ">=3.11"`, ruff/mypy `py311`, `Django`-Pin entfernen,
   `pretix`-Floor realistisch, Build auf `pretix-plugin-build` umstellen, Versions-`attr`.
4. `python -m pretix check` + `makemigrations --check` lokal/CI grün bekommen.

**Phase 3b — Security- & Checkout-Blocker**
5. `views_control.py`: `@event_permission_required("can_change_event_settings")` (oder Mixin),
   `request.event` statt Slug-Lookup, Uploads härten (defusedxml, MIME-Sniffing, PIL-Limit,
   SVG-Sanitisierung/whitelist).
6. `views_api.py`: `csrf_exempt` entfernen; Hold/Release/Autoseat an **CartPosition/Session**
   binden; anonyme Schreibzugriffe unterbinden; `confirm-sale` aus dem Verkaufsweg nehmen
   (nur Admin-Block/Unblock bleibt); saubere JSON-Fehlercodes.
7. `signals.py`: `html_head` (Selector ohne Theme-Hack), `validate_cart`, `validate_order`,
   `order_placed`, `order_canceled`, `order_expired`, `order_changed`, `periodic_task`,
   `order_position_meta_display` anbinden.
8. `models.py`: FK `SeatCategory → Item/ItemVariation` (optional Quota); `SeatHold.cart_position`
   (FK), `SeatAssignment(order_position FK, seat, …)`; SeatState als reine Status-Projektion
   führen. Additive Migrationen (nullable).
9. `services/holds.py`: SeatState-Zeilen vor-materialisieren oder `get_or_create`+re-`select_for_
   update`; IntegrityError-Retry; Teil-Holds als Fehler behandeln (all-or-nothing) bzw. bewusst.

**Phase 3c — Editor/UX, Tests, Doku**
10. Shop: Mobile-first Selector (Pinch/Pan, Bottom-Sheet, ARIA, Tastatur, Availability-Refresh,
    sichtbarer Hold-Ablauf), via `html_head` eingebunden.
11. Editor: Touch-Targets, Performance (Viewport-Culling) bzw. dokumentierte Grenze, A11y-Basics.
12. Tests: DB-/Transaktions-/Hold-/Order-/Permission-/Upload-Tests; `conftest.py` +
    `DJANGO_SETTINGS_MODULE`; `pretix check` in CI; ruff/mypy/pytest grün.
13. Doku: README/INSTALL/DEVELOPER-GUIDE/THEME-INTEGRATION/CHANGELOG aktualisieren (inkl. Limits,
    bekannte Einschränkungen, Upgrade/Migration, Troubleshooting).

---

## 8. Empfohlene Zielarchitektur (Kurzfassung)

- **Sitzplan-Daten:** Organizer-scoped `SeatingPlan` (Preset/Instanz) + `SeatingPlanVersion`
  (Rollback) — bleibt im Kern erhalten.
- **Event-Bindung:** `EventSeatPlanMapping(event, subevent?, plan, active_version)` — bleibt.
- **Verkaufs-Mapping (neu):** `SeatCategory` ⇄ `Item`/`ItemVariation` (FK), optional `Quota`.
- **Laufzeit-Status:** **eine** führende Quelle. Empfehlung: `SeatHold(cart_position FK,
  expires_at)` für temporäre Reservierung + `SeatAssignment(order_position FK)` für verkauft;
  `SeatState` nur als materialisierte Projektion/Cache für schnelle Verfügbarkeitsabfragen, mit
  `select_for_update` + Unique-Constraint `(event, subevent, seat)`.
- **Checkout (pretix-nativ):** Selector via `html_head`; Hold an `CartPosition`;
  `validate_cart`/`validate_order` prüfen Sitzpflicht + Kategorie⇄Variation atomar;
  `order_placed` überträgt Hold→Assignment; `order_canceled/expired/changed` geben frei/bewerten neu;
  `order_position_meta_display` zeigt den Sitz.
- **API (intern):** GET plan/availability (öffentlich, read-only); POST hold/renew/release/autoseat
  **mit CSRF + Session-/Cart-Bindung**; Admin block/unblock + import/export **mit
  Event-Permissions**. Kein anonymer Schreibzugriff, kein `confirm-sale` als Verkaufsweg.
- **Aufräumen:** `periodic_task` (effizient, nur Events mit Mapping), zusätzlich Lazy-Cleanup im Hot-Path.

---

## 9. Liste betroffener Dateien

| Datei | Änderungsbedarf |
|---|---|
| `pretix_smartseating/__init__.py` | `default_app_config` raus, `__version__` |
| `pretix_smartseating/apps.py` | PluginConfig, `default=True`, Meta-Felder |
| `pretix_smartseating/signals.py` | komplette Lifecycle-/Presale-Integration |
| `pretix_smartseating/views_api.py` | CSRF/Permissions/Bindung/Fehlercodes |
| `pretix_smartseating/views_control.py` | Event-Permissions, Upload-Härtung |
| `pretix_smartseating/models.py` | Item/Variation/Order-FKs, Hold/Assignment |
| `pretix_smartseating/services/holds.py` | Locking, Retry, all-or-nothing |
| `pretix_smartseating/services/import_export.py` | Validierung/Sanitisierung |
| `pretix_smartseating/urls.py` | Namespaces, Endpunkt-Schutz |
| `pretix_smartseating/static/.../js/shop.js` | Mobile-first, A11y, Hold-UX |
| `pretix_smartseating/static/.../js/editor.js` | Touch/Perf/A11y |
| `pyproject.toml` | Python/Django/pretix, Build-Backend |
| `pretixplugin.toml`, `MANIFEST.in` | Package-Data prüfen |
| `tests/*`, `.github/workflows/ci.yml` | echte Tests, `pretix check` |
| `README.md`, `INSTALL.md`, `docs/*`, `CHANGELOG.md` | aktualisieren |

---

## 10. Migrationsrisiken

- **Additiv & nullable zuerst:** Neue FKs (`SeatCategory.item/variation`, `SeatHold.cart_position`,
  `SeatAssignment.order_position`) als `null=True` einführen → kein Datenverlust an Bestandszeilen.
- **`scope_organizer` nicht** rückwirkend auf `NOT NULL` zwingen ohne Daten-Migration.
- **Keine Tabellen löschen** (`SeatHold`/`SeatState`) im selben Schritt: erst dual betreiben,
  Projektion neu aufbauen, später optional aufräumen.
- Bestehende Migrationen `0001_initial`, `0002_seatingtemplateasset` bleiben; neue Migrationen rein
  additiv. `makemigrations --check --dry-run` muss in CI sauber sein.
- Unique-Constraints (`smartseat_unique_event_seat_state`, Hold-Constraints) beim Umbau beibehalten,
  sonst drohen Doppelbuchungen.

---

## 11. Testplan

**Unit**
- Import/Export-Roundtrip; Validierung (dup external_id, dup sichtbarer Sitz, unbekannte Kategorie, out-of-bounds).
- Autoseat: strict_adjacent / nearby_row_flexible / best_available / Kategorie- & Accessible-Filter.

**Datenbank / Transaktion**
- Hold erstellen/erneuern/freigeben; abgelaufener Hold wird frei; `select_for_update`.
- **Parallele Holds** auf denselben Sitz (zwei Transaktionen) → genau einer gewinnt; IntegrityError-Retry.
- SubEvent-Trennung der Status.

**Order-Lifecycle**
- `validate_cart`/`validate_order`: Sitzpflicht, Kategorie⇄Variation-Mapping (positiv/negativ).
- `order_placed` → Assignment + `meta_info`-Sitzlabel + Hold gelöscht.
- `order_canceled`/`order_expired` → Assignment frei.
- `order_changed` → Neubewertung.

**Security**
- Control-View ohne Event-Permission → 403; fremder Organizer → 404/403 (kein IDOR).
- API-POST ohne CSRF/Session → abgewiesen; anonymer Hold nicht möglich.
- Upload: zu groß, falsche MIME, bösartiges SVG (Entity-Expansion), Decompression-Bomb → abgewiesen.

**System**
- `python -m pretix check`, `makemigrations --check`, `ruff check`, `mypy`, `pytest` grün.
- Optional: ein Mobile-Selektor-Smoke-Test (Playwright), falls CI-Browser verfügbar.

---

## 12. Definition of Done (Tracking)

Stand nach Umsetzung (Branch `feat/production-readiness`, Plugin 0.3.0,
verifiziert gegen lokal installiertes pretix 2026.3.1):

- [x] Installierbar mit aktueller pretix-Version (Discovery als `PluginApp`, default=True, level=event)
- [x] System-Check grün (`manage check`, 0 issues; CI-Schritt ergänzt). `python -m pretix check`
      benötigt eine pretix-Config; das Django-System-Check ist das CI-taugliche Äquivalent.
- [x] Migrationen laufen sauber (falscher `base`→`pretixbase`-Bug behoben; `makemigrations --check` ok)
- [x] Static Files korrekt eingebunden (Editor-Assets unverändert)
- [x] Sitzplan im Backend erstellbar
- [x] Preset erstellen & auf Event anwenden
- [x] Sitzwahl im Shop **nativ** (pretix-Core rendert; kein Theme-Hack) — über „Apply to event"
- [x] Holds zuverlässig; parallele Doppelbuchung verhindert — **durch pretix-Core** (CartPosition,
      `select_for_update`)
- [x] Orders übernehmen Sitze final — pretix-Core (`OrderPosition.seat`)
- [x] Cancel/Expire gibt Sitze frei — pretix-Core
- [x] Sitz auf Bestellung/Ticket/Admin sichtbar — pretix-Core
- [x] Permissions & CSRF sauber (`event_permission_required`, Standard-CSRF; anonyme Schreib-API entfernt)
- [x] Tests kritischer Pfade grün (25 Tests: native Sync, blocked, Idempotenz, Permissions, Upload-Härtung)
- [x] README/INSTALL/AUDIT/CHANGELOG aktuell

### Bewusst verschoben / dokumentierte Grenzen
- Mobile-first Selector-Widget: entfällt, da pretix-Core die Sitzauswahl rendert (Roadmap: optionales
  Zusatz-Widget).
- Auto-Seat: als Service vorhanden, noch nicht an die native Sitzauswahl angebunden.
- Editor-Performance für 10k+ Sitze: Viewport-Culling vorgesehen, aktuell ~2.000 Sitze flüssig.
- Entfernte Alt-Modelle (`SeatState`/`SeatHold`/`SeatAuditLog`) — keine Daten-Migration nötig, da die
  alte Initial-Migration ohnehin nie anwendbar war.
