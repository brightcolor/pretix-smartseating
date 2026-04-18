from __future__ import annotations

import uuid
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone
from pretix.base.models import Event, SubEvent

from pretix_smartseating.models import (
    EventSeatPlanMapping,
    SeatAuditLog,
    SeatDefinition,
    SeatHold,
    SeatState,
    get_or_create_state,
    purge_expired_holds,
    release_expired_states_for_event,
)


@dataclass
class HoldResult:
    token: uuid.UUID | None
    held_seat_ids: list[int]
    rejected_seat_ids: list[int]
    expires_at: str | None


def _expiry_for_mapping(mapping: EventSeatPlanMapping) -> timezone.datetime:
    return mapping.get_hold_expiry()


def release_expired(event: Event, subevent: SubEvent | None) -> int:
    release_expired_states_for_event(event, subevent)
    return purge_expired_holds(event, subevent)


@transaction.atomic
def create_hold(
    *,
    event: Event,
    subevent: SubEvent | None,
    mapping: EventSeatPlanMapping,
    seats: list[SeatDefinition],
    customer_ref: str = "",
) -> HoldResult:
    release_expired(event, subevent)
    token = uuid.uuid4()
    expires_at = _expiry_for_mapping(mapping)
    held: list[int] = []
    rejected: list[int] = []

    for seat in seats:
        locked_state = (
            SeatState.objects.select_for_update()
            .filter(event=event, subevent=subevent, seat=seat)
            .first()
        )
        if locked_state and locked_state.status in (SeatState.Status.SOLD, SeatState.Status.BLOCKED):
            rejected.append(seat.id)
            continue
        state = get_or_create_state(event, subevent, seat)
        if state.status not in (SeatState.Status.AVAILABLE,):
            rejected.append(seat.id)
            continue
        state.status = SeatState.Status.HOLD
        state.hold_token = token
        state.expires_at = expires_at
        state.save(update_fields=["status", "hold_token", "expires_at", "updated_at"])
        SeatHold.objects.create(
            token=token,
            event=event,
            subevent=subevent,
            seat=seat,
            expires_at=expires_at,
            customer_ref=customer_ref,
            reason="checkout_hold",
        )
        SeatAuditLog.objects.create(
            event=event,
            seat=seat,
            action=SeatAuditLog.Action.HOLD_CREATED,
            payload={"token": str(token), "expires_at": expires_at.isoformat()},
        )
        held.append(seat.id)

    if not held:
        return HoldResult(token=None, held_seat_ids=[], rejected_seat_ids=rejected, expires_at=None)
    return HoldResult(
        token=token,
        held_seat_ids=held,
        rejected_seat_ids=rejected,
        expires_at=expires_at.isoformat(),
    )


@transaction.atomic
def release_hold(*, token: uuid.UUID, event: Event, subevent: SubEvent | None) -> int:
    hold_rows = SeatHold.objects.select_for_update().filter(
        token=token,
        event=event,
        subevent=subevent,
    )
    seat_ids = list(hold_rows.values_list("seat_id", flat=True))
    updated = (
        SeatState.objects.filter(
            event=event,
            subevent=subevent,
            seat_id__in=seat_ids,
            hold_token=token,
            status=SeatState.Status.HOLD,
        )
        .update(status=SeatState.Status.AVAILABLE, hold_token=None, expires_at=None)
    )
    hold_rows.delete()
    for seat_id in seat_ids:
        SeatAuditLog.objects.create(
            event=event,
            seat_id=seat_id,
            action=SeatAuditLog.Action.HOLD_RELEASED,
            payload={"token": str(token)},
        )
    return updated

