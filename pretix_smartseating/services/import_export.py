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
    )


@transaction.atomic
def import_plan(
    target_plan: SeatingPlan,
    payload: dict[str, Any],
    *,
    replace_existing: bool = True,
    save_version: bool = True,
) -> list[dict[str, Any]]:
    issues = [asdict(issue) for issue in validate_layout_payload(payload)]
    if issues:
        return issues

    target_plan.width = payload.get("plan", {}).get("width", target_plan.width)
    target_plan.height = payload.get("plan", {}).get("height", target_plan.height)
    target_plan.grid_size = payload.get("plan", {}).get("grid_size", target_plan.grid_size)
    target_plan.snap_enabled = payload.get("plan", {}).get("snap_enabled", target_plan.snap_enabled)
    target_plan.save(update_fields=["width", "height", "grid_size", "snap_enabled", "updated_at"])

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
