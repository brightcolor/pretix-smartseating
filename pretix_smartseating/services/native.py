"""Bridge the smartseating editor data model to pretix' native seating.

The editor lets users design a plan with rich tooling (background images, arc
rows, categories, accessibility flags). For the actual sale we do *not*
reinvent holds/checkout: we translate the plan into pretix' own
``SeatingPlan`` layout JSON, assign it to the event/subevent, create the
``SeatCategoryMapping`` rows and let pretix core generate the ``Seat`` objects.
From there pretix handles availability, holds (via ``CartPosition.expires``),
locking, the order lifecycle and ticket/admin display natively.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from django.db import transaction
from django.db.models import Q
from django_scopes import scope
from pretix.base.models import Event, Item, SubEvent
from pretix.base.models.seating import (
    SeatCategoryMapping,
    SeatingPlan as PretixSeatingPlan,
    SeatingPlanLayoutValidator,
)
from pretix.base.models import Seat as PretixSeat
from pretix.base.services.seating import SeatProtected, generate_seats

from pretix_smartseating.models import SeatingPlan as LocalPlan
from pretix_smartseating.services.autoseat import AutoSeatOptions, Candidate, find_seats

# Layout category used for seats that have no explicit category assigned.
DEFAULT_CATEGORY_NAME = "uncategorized"


@dataclass
class SyncResult:
    pretix_plan_id: int
    seat_count: int
    blocked_count: int
    mapped_categories: list[str] = field(default_factory=list)
    unmapped_categories: list[str] = field(default_factory=list)


def _seat_guid(seat) -> str:
    # SeatDefinition.guid is a UUID4 -> globally unique and free of whitespace,
    # which satisfies pretix' seat_guid schema constraints.
    return str(seat.guid)


def build_pretix_layout(plan: LocalPlan) -> dict:
    """Translate a local editor plan into a pretix-compatible layout dict.

    Seats are grouped into zones (by ``block_label``) and rows (by
    ``row_label``). Positions are emitted as absolute coordinates with
    zero-offset zones/rows, matching pretix' additive position model.
    The returned dict validates against pretix' seating-plan JSON schema.
    """
    seats = list(plan.seats.select_related("category").all())

    # Categories: every seat must reference a category that exists at top level.
    categories: list[dict] = []
    seen_categories: set[str] = set()
    for category in plan.seat_categories.all():
        if category.code in seen_categories:
            continue
        seen_categories.add(category.code)
        categories.append({"name": category.code, "color": category.color})

    needs_default = any(not s.category_id for s in seats)
    if needs_default and DEFAULT_CATEGORY_NAME not in seen_categories:
        seen_categories.add(DEFAULT_CATEGORY_NAME)
        categories.append({"name": DEFAULT_CATEGORY_NAME, "color": "#9CA3AF"})

    # zone -> row_number -> row dict
    zones: dict[str, dict] = {}
    for seat in seats:
        if seat.is_hidden:
            # Hidden seats are editor-only annotations, never sellable.
            continue
        zone_name = seat.block_label or "Main"
        row_number = seat.row_label or str(seat.row_index or 0)
        zone = zones.get(zone_name)
        if zone is None:
            zone = {"name": zone_name, "position": {"x": 0, "y": 0}, "rows": {}}
            zones[zone_name] = zone
        row = zone["rows"].get(row_number)
        if row is None:
            row = {
                "row_number": row_number,
                "row_label": seat.row_label or None,
                "position": {"x": 0, "y": 0},
                "seats": [],
            }
            zone["rows"][row_number] = row
        row["seats"].append({
            "seat_guid": _seat_guid(seat),
            "seat_number": seat.seat_number or str(seat.seat_index + 1),
            "category": seat.category.code if seat.category_id else DEFAULT_CATEGORY_NAME,
            "position": {"x": float(seat.x), "y": float(seat.y)},
        })

    zone_list = [
        {
            "name": zone["name"],
            "position": zone["position"],
            "rows": list(zone["rows"].values()),
        }
        for zone in zones.values()
    ]

    # Decorative areas (stage/bar/labels) go into a dedicated zone with no rows.
    # ``role`` is editor-only metadata (interactive vs decoration) and is not
    # part of pretix' native area schema, so strip it before validation.
    def _native_area(a):
        return {k: v for k, v in a.items() if k != "role"} if isinstance(a, dict) else a
    area_shapes = [_native_area(a) for a in (plan.area_shapes or [])]
    if area_shapes:
        zone_list.append({
            "name": "Decorations",
            "position": {"x": 0, "y": 0},
            "rows": [],
            "areas": area_shapes,
        })

    layout = {
        "name": plan.name,
        "categories": categories,
        "zones": zone_list,
        "size": {"width": int(plan.width), "height": int(plan.height)},
    }
    # Raises django ValidationError if the layout is malformed.
    SeatingPlanLayoutValidator()(layout)
    return layout


def layout_from_pretix(data: dict) -> dict:
    """Convert a pretix / seats.pretix.eu seating layout into our internal
    editor payload (the shape expected by ``import_plan``).

    Validates against pretix' schema first, then flattens zones/rows into the
    editor's flat seat list (absolute coordinates, block = zone name) and
    collects all decorative areas.
    """
    if not isinstance(data, dict):
        raise ValueError("Layout must be a JSON object.")
    SeatingPlanLayoutValidator()(data)  # raises django ValidationError if invalid

    size = data.get("size") or {}
    width = int(size.get("width") or 1000)
    height = int(size.get("height") or 600)

    categories = []
    for idx, cat in enumerate(data.get("categories", [])):
        name = cat.get("name", "")
        categories.append({
            "code": name,
            "name": name,
            "color": cat.get("color", "#3B82F6"),
            "price_rank": (idx + 1) * 10,
        })

    seats: list[dict] = []
    areas: list[dict] = []
    zones: list[dict] = []
    for zone in data.get("zones", []):
        zpos = zone.get("position", {})
        zx, zy = float(zpos.get("x", 0)), float(zpos.get("y", 0))
        zone_name = zone.get("name") or zone.get("zone_id") or "Main"
        if zone_name not in [z["name"] for z in zones]:
            zones.append({"name": zone_name})
        areas.extend(zone.get("areas", []) or [])
        for ri, row in enumerate(zone.get("rows", [])):
            rpos = row.get("position", {})
            rx, ry = float(rpos.get("x", 0)), float(rpos.get("y", 0))
            row_number = str(row.get("row_number", ri))
            row_label = row.get("row_label") or row_number
            for si, seat in enumerate(row.get("seats", [])):
                spos = seat.get("position", {})
                seats.append({
                    "external_id": seat["seat_guid"],
                    "block_label": zone_name,
                    "row_label": row_label,
                    "seat_number": str(seat.get("seat_number", si + 1)),
                    "seat_index": si,
                    "row_index": ri,
                    "category_code": seat.get("category"),
                    "x": zx + rx + float(spos.get("x", 0)),
                    "y": zy + ry + float(spos.get("y", 0)),
                })

    return {
        "plan": {"name": data.get("name", ""), "width": width, "height": height,
                 "grid_size": 10, "snap_enabled": True},
        "bounds": {"width": width, "height": height},
        "categories": categories,
        "seats": seats,
        "areas": areas,
        "zones": zones,
    }


def blocked_seat_guids(plan: LocalPlan) -> set[str]:
    qs = plan.seats.filter(Q(is_blocked=True) | Q(is_technical_blocked=True))
    return {str(guid) for guid in qs.values_list("guid", flat=True)}


@transaction.atomic
def sync_plan_to_event(
    *,
    event: Event,
    plan: LocalPlan,
    product_map: dict[str, Item | None],
    subevent: SubEvent | None = None,
) -> SyncResult:
    """Push a local plan to pretix' native seating for the given (sub)event.

    ``product_map`` maps local category codes to pretix ``Item`` objects (or
    ``None`` to leave a category unsold). Idempotent: re-running updates the
    existing pretix plan, mappings and seats, protecting already-sold seats
    (``generate_seats`` raises :class:`SeatProtected`).
    """
    with scope(organizer=event.organizer):
        layout = build_pretix_layout(plan)

        pretix_plan = plan.pretix_plan
        if pretix_plan is None:
            pretix_plan = PretixSeatingPlan(organizer=event.organizer)
        pretix_plan.name = plan.name
        pretix_plan.layout = json.dumps(layout)
        pretix_plan.save()
        if plan.pretix_plan_id != pretix_plan.pk:
            plan.pretix_plan = pretix_plan
            plan.save(update_fields=["pretix_plan", "updated_at"])

        target = subevent or event
        if target.seating_plan_id != pretix_plan.pk:
            target.seating_plan = pretix_plan
            target.save(update_fields=["seating_plan"])

        # Rebuild category -> product mappings for this (sub)event.
        SeatCategoryMapping.objects.filter(event=event, subevent=subevent).delete()
        layout_categories = [c["name"] for c in layout["categories"]]
        mapping: dict[str, Item] = {}
        mapped: list[str] = []
        unmapped: list[str] = []
        for category_name in layout_categories:
            product = product_map.get(category_name)
            if product is None:
                unmapped.append(category_name)
                continue
            SeatCategoryMapping.objects.create(
                event=event,
                subevent=subevent,
                layout_category=category_name,
                product=product,
            )
            mapping[category_name] = product
            mapped.append(category_name)

        blocked = blocked_seat_guids(plan)
        # Raises SeatProtected if a now-removed seat is already sold.
        generate_seats(event, subevent, pretix_plan, mapping, blocked_guids=blocked or None)

        seat_count = sum(len(r["seats"]) for z in layout["zones"] for r in z["rows"])
        return SyncResult(
            pretix_plan_id=pretix_plan.pk,
            seat_count=seat_count,
            blocked_count=len(blocked),
            mapped_categories=mapped,
            unmapped_categories=unmapped,
        )


def detach_plan_from_event(*, event: Event, subevent: SubEvent | None = None) -> None:
    """Remove the native seating plan + mappings from a (sub)event.

    Raises :class:`SeatProtected` if seats are already sold.
    """
    with scope(organizer=event.organizer), transaction.atomic():
        target = subevent or event
        if target.seating_plan_id is None:
            return
        from pretix.base.services.seating import validate_plan_change
        validate_plan_change(event, subevent, None)
        generate_seats(event, subevent, None, {})
        SeatCategoryMapping.objects.filter(event=event, subevent=subevent).delete()
        target.seating_plan = None
        target.save(update_fields=["seating_plan"])


@dataclass
class SeatSuggestion:
    seat_guid: str
    label: str
    x: float | None
    y: float | None


def suggest_seats(
    *,
    event: Event,
    plan: LocalPlan,
    quantity: int,
    mode: str = "strict_adjacent",
    subevent: SubEvent | None = None,
    category_code: str | None = None,
    require_accessible: bool = False,
) -> list[SeatSuggestion]:
    """Auto-seat over pretix' *native* availability.

    Reuses the editor's geometry/category data (rich ``SeatDefinition`` rows)
    to run the ranking algorithm, but only considers seats that pretix core
    currently reports as available (``Seat.is_available()``) — so suggestions
    never collide with live carts, orders or vouchers. Returns the chosen
    seats (by native ``seat_guid``); booking still happens through pretix'
    own cart/checkout. Empty list means no suitable group was found.
    """
    with scope(organizer=event.organizer):
        native = {
            s.seat_guid: s
            for s in PretixSeat.objects.filter(event=event, subevent=subevent).select_related("product")
        }
        if not native:
            return []

        available_local = []
        for seat in plan.seats.select_related("category").all():
            native_seat = native.get(str(seat.guid))
            if native_seat is None:
                continue
            if not native_seat.is_available():
                continue
            available_local.append(seat)

        candidate: Candidate | None = find_seats(
            available_local,
            AutoSeatOptions(
                quantity=quantity,
                mode=mode,
                category_code=category_code,
                require_accessible=require_accessible,
            ),
        )
        if not candidate:
            return []

        suggestions = []
        for seat in candidate.seats:
            native_seat = native[str(seat.guid)]
            suggestions.append(
                SeatSuggestion(
                    seat_guid=str(seat.guid),
                    label=str(native_seat),
                    x=seat.x,
                    y=seat.y,
                )
            )
        return suggestions


__all__ = [
    "SyncResult",
    "SeatSuggestion",
    "SeatProtected",
    "build_pretix_layout",
    "layout_from_pretix",
    "blocked_seat_guids",
    "sync_plan_to_event",
    "detach_plan_from_event",
    "suggest_seats",
    "DEFAULT_CATEGORY_NAME",
]
