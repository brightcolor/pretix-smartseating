"""Public, read-only presale endpoints.

Only GET/read access is exposed here. Seat holds, the cart and orders are
handled entirely by pretix core; this endpoint merely *suggests* an available
seat group (auto-seat) computed from pretix' native availability, which the
shop frontend can then pre-select. No state is written, so there is no
DoS/CSRF surface.
"""
from dataclasses import asdict

from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_GET
from django_scopes import scope, scopes_disabled
from pretix.base.models import Event, SubEvent

from pretix_smartseating.models import EventSeatPlanMapping
from pretix_smartseating.services.native import suggest_seats

ALLOWED_MODES = {"strict_adjacent", "nearby_row_flexible", "best_available"}
MAX_SUGGEST_QUANTITY = 20


def _error(message: str, code: str = "bad_request", status: int = 400) -> JsonResponse:
    return JsonResponse({"ok": False, "error": code, "message": message}, status=status)


@require_GET
def api_suggest(request: HttpRequest, organizer: str, event: str) -> JsonResponse:
    with scopes_disabled():
        event_obj = get_object_or_404(Event, organizer__slug=organizer, slug=event)

    try:
        quantity = int(request.GET.get("quantity", "1"))
    except (TypeError, ValueError):
        return _error("quantity must be an integer.", "invalid_quantity")
    if quantity < 1 or quantity > MAX_SUGGEST_QUANTITY:
        return _error(f"quantity must be between 1 and {MAX_SUGGEST_QUANTITY}.", "invalid_quantity")

    mode = request.GET.get("mode", "strict_adjacent")
    if mode not in ALLOWED_MODES:
        return _error("Unsupported mode.", "invalid_mode")

    category = request.GET.get("category") or None
    require_accessible = request.GET.get("accessible") in ("1", "true", "True")

    with scope(organizer=event_obj.organizer):
        subevent = None
        raw_subevent = request.GET.get("subevent")
        if raw_subevent:
            try:
                subevent = get_object_or_404(SubEvent, event=event_obj, pk=int(raw_subevent))
            except (TypeError, ValueError):
                return _error("Invalid subevent.", "invalid_subevent")

        mapping = (
            EventSeatPlanMapping.objects.filter(event=event_obj, subevent=subevent).first()
            or EventSeatPlanMapping.objects.filter(event=event_obj, subevent__isnull=True).first()
        )
        if not mapping:
            return JsonResponse({"ok": True, "seats": [], "count": 0})

        suggestions = suggest_seats(
            event=event_obj,
            plan=mapping.plan,
            quantity=quantity,
            mode=mode,
            subevent=subevent,
            category_code=category,
            require_accessible=require_accessible,
        )

    return JsonResponse(
        {"ok": True, "count": len(suggestions), "seats": [asdict(s) for s in suggestions]}
    )
