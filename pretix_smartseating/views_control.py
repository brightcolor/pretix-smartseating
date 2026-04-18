import json

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods
from pretix.base.models import Event

from pretix_smartseating.forms import ImportPlanForm, SeatingPlanForm
from pretix_smartseating.models import EventSeatPlanMapping, SeatingPlan
from pretix_smartseating.services.import_export import export_plan, import_plan


def _event_from_url(organizer: str, event: str) -> Event:
    return get_object_or_404(Event, organizer__slug=organizer, slug=event)


@login_required
def plan_list(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    mappings = (
        EventSeatPlanMapping.objects.select_related("plan")
        .filter(event=event_obj, subevent__isnull=True)
        .order_by("plan__name")
    )
    plans = SeatingPlan.objects.filter(scope_organizer=event_obj.organizer).order_by("name")
    return render(
        request,
        "pretix_smartseating/control/plan_list.html",
        {"event": event_obj, "plans": plans, "mappings": mappings},
    )


@login_required
@require_http_methods(["GET", "POST"])
def plan_create(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    if request.method == "POST":
        form = SeatingPlanForm(request.POST)
        if form.is_valid():
            plan = form.save(commit=False)
            plan.scope_organizer = event_obj.organizer
            plan.save()
            EventSeatPlanMapping.objects.get_or_create(event=event_obj, subevent=None, defaults={"plan": plan})
            messages.success(request, "Seating plan created.")
            return redirect(
                reverse(
                    "plugins:pretix_smartseating:control.plan_editor",
                    kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
                )
            )
    else:
        form = SeatingPlanForm()
    return render(request, "pretix_smartseating/control/plan_form.html", {"form": form, "event": event_obj})


@login_required
@require_http_methods(["GET"])
def plan_editor(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    return render(
        request,
        "pretix_smartseating/control/editor.html",
        {"event": event_obj, "plan": plan},
    )


@login_required
@require_http_methods(["POST"])
def plan_save_layout(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    payload = json.loads(request.body.decode("utf-8"))
    issues = import_plan(plan, payload, replace_existing=True, save_version=True)
    if issues:
        return JsonResponse({"ok": False, "issues": issues}, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_http_methods(["GET"])
def plan_export(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    bundle = export_plan(plan)
    return JsonResponse(
        {
            "plan": bundle.plan,
            "categories": bundle.categories,
            "seats": bundle.seats,
            "metadata": bundle.metadata,
        }
    )


@login_required
@require_http_methods(["GET", "POST"])
def plan_import(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    if request.method == "POST":
        form = ImportPlanForm(request.POST)
        if form.is_valid():
            issues = import_plan(
                plan,
                form.cleaned_data["payload"],
                replace_existing=form.cleaned_data["replace_existing"],
            )
            if issues:
                for issue in issues:
                    messages.error(request, f"{issue['code']}: {issue['message']}")
            else:
                messages.success(request, "Plan imported.")
                return redirect(
                    reverse(
                        "plugins:pretix_smartseating:control.plan_editor",
                        kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
                    )
                )
    else:
        form = ImportPlanForm()
    return render(
        request,
        "pretix_smartseating/control/plan_import.html",
        {"form": form, "event": event_obj, "plan": plan},
    )

