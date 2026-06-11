from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from django.db import transaction

from pretix_smartseating.models import SeatCategory, SeatDefinition, SeatingPlan, SeatingPlanVersion
from pretix_smartseating.services.validation import validate_layout_payload


@dataclass
class ExportBundle:
    plan: dict[str, Any]
    categories: list[dict[str, Any]]
    seats: list[dict[str, Any]]
    metadata: dict[str, Any]
    areas: list[dict[str, Any]]
    groups: list[dict[str, Any]]
    zones: list[dict[str, Any]]


def _zones_for(plan: SeatingPlan, seats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Zone list = persisted plan.zones, unioned with any block_label actually
    used by a seat (so imported plans expose their zones even without an
    explicit zones list). Order: persisted first, then newly seen."""
    names: list[str] = []
    for z in (plan.zones or []):
        name = (z or {}).get("name")
        if name and name not in names:
            names.append(name)
    for seat in seats:
        name = seat.get("block_label")
        if name and name not in names:
            names.append(name)
    return [{"name": n} for n in names]


def export_plan(plan: SeatingPlan) -> ExportBundle:
    categories = [
        {
            "code": category.code,
            "name": category.name,
            "color": category.color,
            "price_rank": category.price_rank,
        }
        for category in plan.seat_categories.all()
    ]
    seats = [
        {
            "id": seat.id,
            "external_id": seat.external_id,
            "display_name": seat.display_name,
            "block_label": seat.block_label,
            "row_label": seat.row_label,
            "seat_number": seat.seat_number,
            "seat_index": seat.seat_index,
            "row_index": seat.row_index,
            "x": seat.x,
            "y": seat.y,
            "rotation": seat.rotation,
            "category_code": seat.category.code if seat.category else None,
            "seat_type": seat.seat_type,
            "is_accessible": seat.is_accessible,
            "is_companion": seat.is_companion,
            "is_hidden": seat.is_hidden,
            "is_blocked": seat.is_blocked,
            "is_technical_blocked": seat.is_technical_blocked,
            "notes": seat.notes,
            "metadata": seat.metadata,
        }
        for seat in plan.seats.select_related("category").all()
    ]
    return ExportBundle(
        plan={
            "slug": plan.slug,
            "name": plan.name,
            "description": plan.description,
            "width": plan.width,
            "height": plan.height,
            "grid_size": plan.grid_size,
            "snap_enabled": plan.snap_enabled,
        },
        categories=categories,
        seats=seats,
        metadata={"export_format": "pretix-smartseating-v1"},
        areas=list(plan.area_shapes or []),
        groups=list(plan.seat_groups or []),
        zones=_zones_for(plan, seats),
    )


def seats_from_svg(svg_text: str, *, prefix: str = "seat-") -> dict[str, Any]:
    """Build an import payload from an SVG floor plan (id convention).

    Every ``<circle>``/``<ellipse>``/``<rect>`` whose ``id`` starts with
    ``prefix`` becomes a seat at the element's centre. The id remainder is the
    seat label: a leading letter block is the row, trailing digits the number
    (``seat-A12`` → row A, seat 12). Transforms are not applied; the plan size
    comes from the SVG viewBox (or width/height attributes).
    """
    import re

    from defusedxml import ElementTree as DET

    root = DET.fromstring(svg_text)

    def _num(value):
        if value is None:
            return None
        m = re.match(r"^\s*(-?[0-9.]+)", str(value))
        return float(m.group(1)) if m else None

    width = height = None
    vb = root.get("viewBox")
    if vb:
        parts = vb.replace(",", " ").split()
        if len(parts) == 4:
            width, height = _num(parts[2]), _num(parts[3])
    if not width:
        width = _num(root.get("width")) or 1200
    if not height:
        height = _num(root.get("height")) or 800

    raw = []
    seq = 0
    for el in root.iter():
        el_id = el.get("id") or ""
        if not el_id.startswith(prefix):
            continue
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in ("circle", "ellipse"):
            x, y = _num(el.get("cx")), _num(el.get("cy"))
        elif tag == "rect":
            x = (_num(el.get("x")) or 0) + (_num(el.get("width")) or 0) / 2
            y = (_num(el.get("y")) or 0) + (_num(el.get("height")) or 0) / 2
        else:
            continue
        if x is None or y is None:
            continue
        seq += 1
        label = el_id[len(prefix):]
        m = re.match(r"^([A-Za-z]*)[-_ ]?(\d+)$", label)
        row = m.group(1) if m and m.group(1) else "S"
        number = m.group(2) if m else str(seq)
        raw.append({"external_id": el_id, "row": row, "number": number, "x": x, "y": y})

    if not raw:
        raise ValueError(f"No SVG elements with an id starting with '{prefix}' were found.")

    row_order = {label: idx for idx, label in enumerate(sorted({s["row"] for s in raw}))}
    seats = [
        {
            "external_id": s["external_id"],
            "block_label": "Main",
            "row_label": s["row"],
            "seat_number": s["number"],
            "seat_index": idx,
            "row_index": row_order[s["row"]],
            "x": s["x"],
            "y": s["y"],
            "category_code": "standard",
        }
        for idx, s in enumerate(raw)
    ]
    return {
        "plan": {"width": int(width), "height": int(height)},
        "categories": [{"code": "standard", "name": "Standard", "color": "#3B82F6"}],
        "seats": seats,
        "areas": [],
        "groups": [],
    }


@transaction.atomic
def import_plan(
    target_plan: SeatingPlan,
    payload: dict[str, Any],
    *,
    replace_existing: bool = True,
    save_version: bool = True,
) -> list[dict[str, Any]]:
    # Non-blocking advisories: duplicate visible labels (block/row/seat) are
    # legitimate in real plans (seats.pretix.eu repeats them across segments);
    # only the seat GUID must be unique. So they never block an import.
    NON_BLOCKING = {"duplicate_visible_seat"}
    issues = [asdict(issue) for issue in validate_layout_payload(payload)]
    blocking = [i for i in issues if i.get("code") not in NON_BLOCKING]
    if blocking:
        return blocking

    target_plan.width = payload.get("plan", {}).get("width", target_plan.width)
    target_plan.height = payload.get("plan", {}).get("height", target_plan.height)
    target_plan.grid_size = payload.get("plan", {}).get("grid_size", target_plan.grid_size)
    target_plan.snap_enabled = payload.get("plan", {}).get("snap_enabled", target_plan.snap_enabled)
    if "areas" in payload and isinstance(payload["areas"], list):
        target_plan.area_shapes = payload["areas"]
    if "groups" in payload and isinstance(payload["groups"], list):
        target_plan.seat_groups = payload["groups"]
    if "zones" in payload and isinstance(payload["zones"], list):
        target_plan.zones = payload["zones"]
    target_plan.save(
        update_fields=[
            "width", "height", "grid_size", "snap_enabled",
            "area_shapes", "seat_groups", "zones", "updated_at",
        ]
    )

    if replace_existing:
        target_plan.seats.all().delete()
        target_plan.seat_categories.all().delete()

    category_map: dict[str, SeatCategory] = {}
    for category_payload in payload.get("categories", []):
        category = SeatCategory.objects.create(
            plan=target_plan,
            code=category_payload["code"],
            name=category_payload.get("name") or category_payload["code"].title(),
            color=category_payload.get("color", "#3B82F6"),
            price_rank=category_payload.get("price_rank", 100),
        )
        category_map[category.code] = category

    for seat_payload in payload.get("seats", []):
        category = category_map.get(seat_payload.get("category_code"))
        SeatDefinition.objects.create(
            plan=target_plan,
            external_id=seat_payload["external_id"],
            display_name=seat_payload.get("display_name", ""),
            block_label=seat_payload.get("block_label", ""),
            row_label=seat_payload.get("row_label", ""),
            seat_number=seat_payload.get("seat_number", ""),
            seat_index=seat_payload.get("seat_index", 0),
            row_index=seat_payload.get("row_index", 0),
            x=seat_payload.get("x", 0),
            y=seat_payload.get("y", 0),
            rotation=seat_payload.get("rotation", 0),
            category=category,
            seat_type=seat_payload.get("seat_type", SeatDefinition.SeatType.NORMAL),
            is_accessible=seat_payload.get("is_accessible", False),
            is_companion=seat_payload.get("is_companion", False),
            is_hidden=seat_payload.get("is_hidden", False),
            is_blocked=seat_payload.get("is_blocked", False),
            is_technical_blocked=seat_payload.get("is_technical_blocked", False),
            notes=seat_payload.get("notes", ""),
            metadata=seat_payload.get("metadata", {}),
        )

    if save_version:
        latest_version = target_plan.versions.order_by("-version_number").first()
        next_version = 1 if not latest_version else latest_version.version_number + 1
        SeatingPlanVersion.objects.create(
            plan=target_plan,
            version_number=next_version,
            layout_json=payload,
            changelog="Imported seating layout",
        )

    return []
