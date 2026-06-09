# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] - 2026-06-09

### Changed
- The **number of seats around a table is now its own field** ("Seats at table",
  default 8), independent from the generic row/block/arc "Seats" count. Round
  tables automatically grow their seat ring as the count rises so seats never
  overlap.

## [0.6.4] - 2026-06-09

### Changed
- Editor creation tools are now **click-to-place**: pick a tool (Row, Block,
  Arc, Table, Stage, Round, Label), set its options in the sidebar, then click
  on the plan exactly where it should go — no more "appears in the centre, then
  drag it" detour. The cursor turns into a copy crosshair while a creation tool
  is active, and **Esc** returns to the Select tool. The sidebar buttons still
  work as a fallback (they drop the element in the centre of the view).

### Fixed
- Table tool, rotation handle and area resize "did nothing" for some users:
  the browser was serving a **stale cached `editor.js`**. Documented the
  dev-server cache-busting step (`collectstatic` + hard reload); production
  deployments already cache-bust via hashed static URLs. No code was broken —
  the features work once the current script is loaded.

## [0.6.3] - 2026-06-08

### Added
- Editor **rotation handle**: rotate a selected area, or a multi-seat
  selection around its centroid, by dragging a handle above the bounding box
  (hold Shift to snap to 15°).
- Editor **alignment guides**: while dragging seats, the lead seat snaps to a
  neighbour's x / y when close and a pink guide line is shown.

## [0.6.2] - 2026-06-08

### Added
- Editor **Table** tool (seats.io-style): drops a round or rectangular table
  (decorative area) with N seats arranged around it in one action; seats use
  the table label as their row and the active zone.

## [0.6.1] - 2026-06-08

### Changed
- Shop tooltip redesigned as a seats.io-style card: a dark header with two
  cells (Row | Seat, big values) and a category-coloured footer strip showing
  the price zone name + price (text colour auto-contrasts). Anchors centred
  above the cursor and flips below near the top edge. Seatmap endpoint now
  returns per-seat `row`, `number` and `cat`.

## [0.6.0] - 2026-06-08

### Fixed
- "Row" generator now respects the **Numbering** setting (sequential / odd-even),
  consistent with the block and arc generators (it previously ignored it).
- "Apply to event" now **saves the editor first**, so it always applies the
  current layout instead of the last saved version.

### Removed
- Redundant standalone shop auto-seat helper (`seatingframe_html_head` +
  `shop_autoseat.js/css`) — superseded by the interactive seat map's
  "Best available" button (it was showing twice on the full-screen seating page).
- Dead leftovers from the old custom hold system: `EventSeatPlanMapping`
  fields `active_version`, `allow_nearby_mode`, `prefer_center`, `prefer_front`,
  `hold_timeout_seconds` (migration 0006) and the unused `AutoSeatForm`.

## [0.5.7] - 2026-06-08

### Changed
- Editor seat properties: removed the redundant accessible/companion/technical
  checkboxes. **Seat type** (the dropdown) is now the single source of truth and
  derives those flags; only **Blocked (not sold)** remains as an independent
  status toggle.

## [0.5.6] - 2026-06-08

### Changed
- Editor visual refresh: calmer neutral palette with an indigo accent,
  consistent rounded inputs/buttons with focus rings, a card-style sidebar
  with uppercase section labels, clearer toolbar (active tool filled),
  refined tabs, and a subtle dot-grid canvas. Pure CSS; no behaviour change.

## [0.5.5] - 2026-06-08

### Fixed
- Shop seat labels/tooltips now read **"Reihe X, Platz Y"** (built from the
  seat's row + number) instead of pretix' default string.
- Price-zone legend dots are now **coloured**: they were inline-styled `<span>`
  swatches, which pretix' Content-Security-Policy blocked; replaced with inline
  SVG circles (the `fill` attribute is CSP-safe, like the seats themselves).

## [0.5.4] - 2026-06-08

### Added
- Shop seat map gains established seat-picker UX (à la seats.io): visible
  **zoom controls** (+/−/fit), a **hover/tap tooltip** (seat label + price),
  a **sticky action bar** on mobile (best-available + running total + CTA
  pinned to the bottom), and a **"Best available"** button that auto-selects
  an adjacent group via the suggestion endpoint.

## [0.5.3] - 2026-06-08

### Changed
- Prettier shop seat map: seats are coloured by their **category / price zone**
  (filled circle), show the seat number, and have polished states (subtle
  shadow, hover, focus, a glowing ring when selected). Decorative areas
  (stage/bar/labels) from the editor are now drawn in the shop too. The
  seatmap endpoint returns `areas`.

## [0.5.2] - 2026-06-08

### Added
- Shop seat map shows **prices**: a price-zone legend (colour · product ·
  price), the price in each seat's tooltip, and a running total while
  selecting. The seatmap endpoint now returns `currency`, `products`
  (id/name/price/colour) and a per-seat `price`.

### Changed
- Shop layout: the normal ticket products are shown first; the seat plan is
  moved **below** them (the renderer relocates itself to the end of the cart
  form, with a "Choose your seats" heading).

## [0.5.1] - 2026-06-08

### Fixed
- Shop seat map now also respects **product quota**: a seat whose product has
  no available quota is shown as unavailable instead of looking bookable and
  then being rejected at cart-add ("product no longer available"). The
  availability endpoint checks `Item.check_quotas` per product.

## [0.5.0] - 2026-06-08

### Added
- **Shop seat map** — the missing piece that makes seats appear in the shop.
  Open-source pretix has the seating data model but ships no shop renderer; it
  only emits the `render_seating_plan` signal (normally handled by the
  commercial seats.pretix.eu integration). This release provides that
  renderer: a read-only seat-map endpoint built from pretix' native
  availability (`Seat.annotated`), an interactive SVG picker (zoom/pan, ARIA,
  category colours, legend) injected via `render_seating_plan`, and its own
  submit button (core hides the add-to-cart button for seated-only events).
  Selected seats are posted as `seat_<product>=<guid>` to pretix' own cart-add
  endpoint, so checkout/holds/orders stay 100% native.

### Fixed
- Seat selection now renders in the shop frontend (previously the page was
  empty because no `render_seating_plan` receiver existed).

## [0.4.0] - 2026-06-08

Editor overhaul toward a seats.pretix.eu-style experience.

### Added
- **First-class Zones** (sidebar list, add/rename/activate/delete, per-zone
  seat counts); a seat's zone is its `block_label`, new seats go to the active
  zone. Persisted in `SeatingPlan.zones`; round-tripped + extracted on import.
- **Tabbed sidebar** (Build / Edit / Plan) with auto-switching; tools moved to
  a top toolbar above the canvas; Plan properties (size, live seat count) and
  per-category seat counts.
- **Resize handles** for areas; **rotation-aware** resize.
- **Seat grouping** (nestable): group/ungroup, select & move a group as one.
- **Decorative areas & labels** (seats.pretix.eu-style): stage,
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
- Shop auto-seat helper injected into the native seating page via
  `seatingframe_html_head` (read-only suggestions).

### Changed
- Save shows an animated check-mark overlay instead of a blocking `alert()`.

### Fixed
- Exact cursor↔canvas mapping via `getScreenCTM()` (marquee/drag/zoom were
  desynced when the canvas aspect ratio differed from the viewBox).
- Background images set `pointer-events: none` so selection/tools work over them.
- Duplicate visible seat labels (block/row/seat) no longer block import; only
  the seat GUID is unique, matching pretix core (DB constraint dropped).

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
