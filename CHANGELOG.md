# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Decorative areas & labels** in the editor (seats.pretix.eu-style): stage,
  bar, round areas and text labels (rectangle/ellipse/text), draggable and
  editable (fill/border colour, size, rotation, text). Stored in
  `SeatingPlan.area_shapes`, round-tripped through save/import/export and
  emitted into the native pretix layout, so they render in the shop too.
- **seats.pretix.eu / native JSON import & export**: "Export pretix JSON"
  download; the import page auto-detects and converts a pretix layout
  (`zones` + `size`) via `native.layout_from_pretix`.
- **Category management UI** (price zones): create/rename/recolour/sort/delete
  categories; assign category + seat type (wheelchair/companion/technical/VIP)
  to the current selection; internal codes hidden.
- **Rectangular block generator** + per-seat-spacing in "Add row".
- **Align & distribute** tools for multi-seat selections.
- Editor pan/zoom (wheel/drag/pinch, double-click to fit) with **viewport
  culling**: only seats inside the visible region are rendered and per-seat
  labels are suppressed above a visibility threshold, so large plans stay
  responsive. Selection no longer redraws the whole plan (only affected nodes
  update).
- Auto-seat wired to native availability: `services.native.suggest_seats`
  ranks an available seat group using `Seat.is_available()` (respects live
  carts/orders/vouchers). New read-only GET endpoint
  `…/smartseating/<org>/<event>/autoseat-suggest/`; booking still goes through
  the pretix cart. Covered by tests (held-seat skip, bad-quantity reject,
  GET-only).

## [0.3.0] - 2026-06-08

Major architecture change: the plugin now integrates with **pretix' native
seating** instead of running a parallel hold/checkout system.

### Added
- `services/native.py`: convert an editor plan to a schema-valid pretix
  seating layout (`build_pretix_layout`), publish it to an event/subevent and
  generate native `Seat` rows with category→product mapping
  (`sync_plan_to_event`), plus `detach_plan_from_event`. Idempotent and
  protects already-sold seats.
- `SeatingPlan.pretix_plan` FK linking the editor plan to the native plan.
- Control view + template **"Apply to event"** to map seat categories to
  products and publish for sale (per event or subevent).
- Django system check step in CI; DB/integration test suite running against a
  real pretix install (native sync, blocked seats, idempotency, permissions,
  upload hardening).

### Changed
- All control views now require the `can_change_event_settings` event
  permission and use `request.event`/`request.organizer` (closes a
  cross-tenant IDOR). Plan lookups are scoped to the organizer.
- Upload hardening: SVG parsed with `defusedxml` and sanitized (script/
  handlers/`javascript:` stripped); raster images verified with Pillow and
  capped (decompression-bomb guard); extension+MIME allowlist; JSON body cap.
- Packaging modernized: `requires-python >=3.11`, build via
  `pretix-plugin-build`, dynamic version, Django no longer pinned directly,
  `defusedxml` dependency added.
- Plugin registration modernized: `PluginConfig` with `default = True`,
  `PretixPluginMeta.level`/`settings_links`/`navigation_links`; removed the
  Django-4.1-removed `default_app_config`.

### Fixed
- **Critical:** initial migration referenced the nonexistent `base` app label
  instead of `pretixbase`, so `migrate` could never run on a real pretix
  install. Regenerated correctly with a `('pretixbase', '__first__')`
  dependency.

### Removed
- Anonymous, `csrf_exempt` write API (`hold`/`release-hold`/`autoseat`/
  `confirm-sale`) and the theme-hack shop selector — obsolete and a DoS/CSRF
  liability under native seating.
- Obsolete `SeatState`/`SeatHold`/`SeatAuditLog` models and the
  `holds`/`availability` services (dual source of truth).

### Migration notes
- Migrate pretix core **before** the plugin (standard install flow).
- Existing installations on 0.2.x could not have applied the broken initial
  migration; treat 0.3.0 as the first migratable release.

## [0.2.0] - 2026-04-22

### Added
- Background template layer system in the seat editor
- Upload support for PNG/JPG/SVG and PDF templates
- Automatic PDF rasterization (first page) for use as editor background
- Layer controls for visibility, lock, position, scale, rotation, opacity and z-index
- Preset workflow:
  - save an existing plan as reusable location preset
  - create a new event plan from preset
  - cloned plans remain fully editable
- Additional editor productivity actions: duplicate selected seats, delete selected seats, keyboard shortcuts

### Changed
- Curved row generation now respects grid snapping when enabled
- Plan list separates active event plans from reusable presets

## [0.1.2] - 2026-04-18

### Fixed
- Resolved `mypy` type-check issues in status-return paths and subevent parsing for CI stability

## [0.1.1] - 2026-04-18

### Added
- Theme integration guide for pretix shop template overrides (`docs/THEME-INTEGRATION.md`)
- Selector snippet now loads required shop styling directly

### Changed
- API input hardening with strict payload validation, mode/quantity bounds checks and structured error responses
- `confirm-sale` endpoint now requires authenticated staff context
- Auto-seat typing decoupled from Django model imports to keep lint/test tooling robust in isolated environments

## [0.1.0] - 2026-04-18

### Added
- Initial pretix plugin scaffolding and package metadata
- Data model for seat plans, versions, seats, categories, event mappings, states, holds and audit log
- JSON import/export service with validation
- Auto-seat service with `strict_adjacent`, `nearby_row_flexible` and `best_available`
- Hold/lock service with expiry handling and conflict-safe updates
- Control panel views and editor template
- Shop seat selector template and JavaScript frontend
- API endpoints for plan retrieval, availability, hold/release, auto-seat and sale confirmation
- Test suite for validation, auto-seat behavior, import/export and API conflict behavior
- Documentation set (`README`, install/admin/developer/architecture docs)
