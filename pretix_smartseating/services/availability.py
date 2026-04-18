from __future__ import annotations

from pretix.base.models import Event, SubEvent

from pretix_smartseating.models import SeatDefinition, SeatState, get_effective_status


def available_seats_for_event(
    *,
    event: Event,
    subevent: SubEvent | None,
    plan_id: int,
    category_code: str | None = None,
    require_accessible: bool = False,
) -> list[SeatDefinition]:
    queryset = SeatDefinition.objects.select_related("category").filter(plan_id=plan_id, is_hidden=False)
    if category_code:
        queryset = queryset.filter(category__code=category_code)
    if require_accessible:
        queryset = queryset.filter(is_accessible=True)

    result: list[SeatDefinition] = []
    for seat in queryset:
        status = get_effective_status(seat, event, subevent)
        if status == SeatState.Status.AVAILABLE:
            result.append(seat)
    return result

