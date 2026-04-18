import json
import uuid

from django.db import transaction
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods
from pretix.base.models import Event, SubEvent

from pretix_smartseating.models import EventSeatPlanMapping, SeatDefinition, SeatState, get_effective_status
from pretix_smartseating.services.autoseat import AutoSeatOptions, find_seats
from pretix_smartseating.services.availability import available_seats_for_event
from pretix_smartseating.services.holds import create_hold, release_expired, release_hold
from pretix_smartseating.services.import_export import export_plan


def _event_context(organizer: str, event: str, subevent_id: int | None = None) -> tuple[Event, SubEvent | None]:
    event_obj = get_object_or_404(Event, organizer__slug=organizer, slug=event)
    subevent = None
    if subevent_id:
        subevent = get_object_or_404(SubEvent, event=event_obj, id=subevent_id)
    return event_obj, subevent


def _mapping(event: Event, subevent: SubEvent | None) -> EventSeatPlanMapping:
    mapping = EventSeatPlanMapping.objects.filter(event=event, subevent=subevent).first()
    if mapping:
        return mapping
    mapping = EventSeatPlanMapping.objects.filter(event=event, subevent__isnull=True).first()
    if not mapping:
        raise EventSeatPlanMapping.DoesNotExist
    return mapping


@require_GET
def api_plan(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    subevent_id = request.GET.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    mapping = _mapping(event_obj, subevent)
    bundle = export_plan(mapping.plan)
    return JsonResponse(
        {
            "plan": bundle.plan,
            "categories": bundle.categories,
            "seats": bundle.seats,
            "metadata": bundle.metadata,
            "plan_id": mapping.plan_id,
        }
    )


@require_GET
def api_availability(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    subevent_id = request.GET.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    mapping = _mapping(event_obj, subevent)
    release_expired(event_obj, subevent)
    statuses = []
    for seat in mapping.plan.seats.select_related("category").all():
        statuses.append(
            {
                "seat_id": seat.id,
                "external_id": seat.external_id,
                "status": get_effective_status(seat, event_obj, subevent),
            }
        )
    return JsonResponse({"plan_id": mapping.plan_id, "statuses": statuses})


@csrf_exempt
@require_http_methods(["POST"])
def api_hold(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    payload = json.loads(request.body.decode("utf-8"))
    subevent_id = payload.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    mapping = _mapping(event_obj, subevent)
    seat_ids = payload.get("seat_ids", [])
    seats = list(SeatDefinition.objects.filter(id__in=seat_ids, plan_id=mapping.plan_id))
    result = create_hold(
        event=event_obj,
        subevent=subevent,
        mapping=mapping,
        seats=seats,
        customer_ref=payload.get("customer_ref", ""),
    )
    return JsonResponse(
        {
            "token": str(result.token) if result.token else None,
            "held_seat_ids": result.held_seat_ids,
            "rejected_seat_ids": result.rejected_seat_ids,
            "expires_at": result.expires_at,
        },
        status=200 if result.token else 409,
    )


@csrf_exempt
@require_http_methods(["POST"])
def api_release_hold(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    payload = json.loads(request.body.decode("utf-8"))
    token = uuid.UUID(payload["token"])
    subevent_id = payload.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    released = release_hold(token=token, event=event_obj, subevent=subevent)
    return JsonResponse({"released": released})


@csrf_exempt
@require_http_methods(["POST"])
def api_autoseat(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    payload = json.loads(request.body.decode("utf-8"))
    quantity = int(payload.get("quantity", 1))
    subevent_id = payload.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    mapping = _mapping(event_obj, subevent)
    options = AutoSeatOptions(
        quantity=quantity,
        mode=payload.get("mode", "strict_adjacent"),
        category_code=payload.get("category"),
        require_accessible=bool(payload.get("require_accessible")),
        nearby_row_flexible=bool(payload.get("nearby_row_flexible", False)),
        prefer_center=bool(payload.get("prefer_center", mapping.prefer_center)),
        prefer_front=bool(payload.get("prefer_front", mapping.prefer_front)),
        preferred_blocks=payload.get("preferred_blocks"),
    )
    seats = available_seats_for_event(
        event=event_obj,
        subevent=subevent,
        plan_id=mapping.plan_id,
        category_code=options.category_code,
        require_accessible=options.require_accessible,
    )
    candidate = find_seats(seats, options)
    if not candidate:
        return JsonResponse({"ok": False, "message": "No suitable seat group found."}, status=404)

    with transaction.atomic():
        hold = create_hold(
            event=event_obj,
            subevent=subevent,
            mapping=mapping,
            seats=candidate.seats,
            customer_ref=payload.get("customer_ref", ""),
        )
    if not hold.token:
        return JsonResponse({"ok": False, "message": "Seats became unavailable during allocation."}, status=409)
    return JsonResponse(
        {
            "ok": True,
            "token": str(hold.token),
            "seat_ids": hold.held_seat_ids,
            "mode": options.mode,
            "reason": candidate.reason,
            "score": candidate.score,
            "expires_at": hold.expires_at,
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def api_confirm_sale(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    payload = json.loads(request.body.decode("utf-8"))
    token = uuid.UUID(payload["token"])
    order_code = payload.get("order_code", "")
    subevent_id = payload.get("subevent")
    event_obj, subevent = _event_context(organizer, event, int(subevent_id) if subevent_id else None)
    updated = (
        SeatState.objects.filter(
            event=event_obj,
            subevent=subevent,
            hold_token=token,
            status=SeatState.Status.HOLD,
        )
        .update(
            status=SeatState.Status.SOLD,
            order_code=order_code,
            expires_at=None,
        )
    )
    return JsonResponse({"sold": updated})

