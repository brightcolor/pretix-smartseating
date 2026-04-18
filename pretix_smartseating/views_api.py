import json
import uuid

from django.core.exceptions import PermissionDenied
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

MAX_BODY_BYTES = 64_000
MAX_HOLD_SEATS = 20
ALLOWED_MODES = {"strict_adjacent", "nearby_row_flexible", "best_available"}


def _error(message: str, status: int = 400, *, code: str = "bad_request") -> JsonResponse:
    return JsonResponse({"ok": False, "error": code, "message": message}, status=status)


def _json_body(request: HttpRequest) -> dict:
    body = request.body or b""
    if len(body) > MAX_BODY_BYTES:
        raise ValueError("Request body is too large.")
    if not body:
        return {}
    return json.loads(body.decode("utf-8"))


def _subevent_from_payload(event_obj: Event, payload: dict) -> SubEvent | None:
    subevent_id = payload.get("subevent")
    if subevent_id in ("", None):
        return None
    try:
        subevent_int = int(str(subevent_id))
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid subevent value.") from exc
    return get_object_or_404(SubEvent, event=event_obj, id=subevent_int)


def _require_staff_for_write(request: HttpRequest):
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated or not user.is_staff:
        raise PermissionDenied("Staff authentication required.")


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
    try:
        payload = _json_body(request)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return _error(str(exc), 400, code="invalid_payload")
    event_obj, _ = _event_context(organizer, event)
    try:
        subevent = _subevent_from_payload(event_obj, payload)
    except ValueError as exc:
        return _error(str(exc), 400, code="invalid_subevent")
    mapping = _mapping(event_obj, subevent)
    seat_ids = payload.get("seat_ids") or []
    if not isinstance(seat_ids, list) or not seat_ids:
        return _error("seat_ids must be a non-empty list.", 400, code="invalid_seat_ids")
    if len(seat_ids) > MAX_HOLD_SEATS:
        return _error(f"At most {MAX_HOLD_SEATS} seats can be held in one request.", 400, code="too_many_seats")
    try:
        seat_ids_int = [int(seat_id) for seat_id in seat_ids]
    except (TypeError, ValueError):
        return _error("seat_ids must contain integers.", 400, code="invalid_seat_ids")
    seats = list(SeatDefinition.objects.filter(id__in=seat_ids, plan_id=mapping.plan_id))
    if len(seats) != len(set(seat_ids_int)):
        return _error("One or more seats are unknown for the selected plan.", 404, code="unknown_seat")
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
    try:
        payload = _json_body(request)
        token = uuid.UUID(str(payload["token"]))
    except KeyError:
        return _error("token is required.", 400, code="missing_token")
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return _error("Invalid token or payload.", 400, code="invalid_token")
    event_obj, _ = _event_context(organizer, event)
    try:
        subevent = _subevent_from_payload(event_obj, payload)
    except ValueError as exc:
        return _error(str(exc), 400, code="invalid_subevent")
    released = release_hold(token=token, event=event_obj, subevent=subevent)
    return JsonResponse({"released": released})


@csrf_exempt
@require_http_methods(["POST"])
def api_autoseat(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    try:
        payload = _json_body(request)
        quantity = int(payload.get("quantity", 1))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return _error("Invalid payload.", 400, code="invalid_payload")
    if quantity < 1 or quantity > MAX_HOLD_SEATS:
        return _error(f"quantity must be between 1 and {MAX_HOLD_SEATS}.", 400, code="invalid_quantity")
    mode = payload.get("mode", "strict_adjacent")
    if mode not in ALLOWED_MODES:
        return _error("Unsupported mode.", 400, code="invalid_mode")
    event_obj, _ = _event_context(organizer, event)
    try:
        subevent = _subevent_from_payload(event_obj, payload)
    except ValueError as exc:
        return _error(str(exc), 400, code="invalid_subevent")
    mapping = _mapping(event_obj, subevent)
    options = AutoSeatOptions(
        quantity=quantity,
        mode=mode,
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
    try:
        _require_staff_for_write(request)
    except PermissionDenied:
        return _error("Authentication required.", 403, code="forbidden")
    try:
        payload = _json_body(request)
        token = uuid.UUID(str(payload["token"]))
    except KeyError:
        return _error("token is required.", 400, code="missing_token")
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return _error("Invalid token or payload.", 400, code="invalid_payload")
    order_code = str(payload.get("order_code", ""))[:120]
    event_obj, _ = _event_context(organizer, event)
    try:
        subevent = _subevent_from_payload(event_obj, payload)
    except ValueError as exc:
        return _error(str(exc), 400, code="invalid_subevent")
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
