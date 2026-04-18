from collections import Counter
from dataclasses import dataclass
from typing import Any


@dataclass
class ValidationIssue:
    code: str
    message: str
    context: dict[str, Any]


def validate_layout_payload(payload: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    seats = payload.get("seats", [])
    categories = {c["code"] for c in payload.get("categories", []) if c.get("code")}

    external_ids = [s.get("external_id") for s in seats if s.get("external_id")]
    dup_external = [item for item, count in Counter(external_ids).items() if count > 1]
    for external_id in dup_external:
        issues.append(
            ValidationIssue(
                code="duplicate_external_id",
                message=f"Duplicate external_id '{external_id}'",
                context={"external_id": external_id},
            )
        )

    readable = [
        (s.get("block_label", ""), s.get("row_label", ""), s.get("seat_number", ""))
        for s in seats
        if s.get("seat_number")
    ]
    dup_readable = [item for item, count in Counter(readable).items() if count > 1]
    for block_label, row_label, seat_number in dup_readable:
        issues.append(
            ValidationIssue(
                code="duplicate_visible_seat",
                message=f"Duplicate seat {block_label}/{row_label}/{seat_number}",
                context={
                    "block_label": block_label,
                    "row_label": row_label,
                    "seat_number": seat_number,
                },
            )
        )

    for seat in seats:
        code = seat.get("category_code")
        if code and code not in categories:
            issues.append(
                ValidationIssue(
                    code="invalid_category",
                    message=f"Seat references unknown category '{code}'",
                    context={"external_id": seat.get("external_id"), "category_code": code},
                )
            )

    bounds = payload.get("bounds") or {"width": 0, "height": 0}
    width = float(bounds.get("width", 0))
    height = float(bounds.get("height", 0))
    for seat in seats:
        x = float(seat.get("x", 0))
        y = float(seat.get("y", 0))
        if x < 0 or y < 0 or (width and x > width) or (height and y > height):
            issues.append(
                ValidationIssue(
                    code="seat_out_of_bounds",
                    message=f"Seat '{seat.get('external_id', 'unknown')}' is out of bounds",
                    context={"external_id": seat.get("external_id"), "x": x, "y": y},
                )
            )

    return issues

