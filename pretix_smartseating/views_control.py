import json
import re
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.files.base import ContentFile
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods
from pretix.base.models import Event
from PIL import Image

from pretix_smartseating.forms import ImportPlanForm, SeatingPlanForm
from pretix_smartseating.models import (
    EventSeatPlanMapping,
    SeatCategory,
    SeatDefinition,
    SeatingPlan,
    SeatingTemplateAsset,
)
from pretix_smartseating.services.import_export import export_plan, import_plan

MAX_TEMPLATE_UPLOAD_BYTES = 25 * 1024 * 1024


def _event_from_url(organizer: str, event: str) -> Event:
    return get_object_or_404(Event, organizer__slug=organizer, slug=event)


def _unique_slug(organizer, desired_slug: str) -> str:
    base = (desired_slug or "seating-plan").strip().lower().replace(" ", "-")
    base = "".join(ch for ch in base if ch.isalnum() or ch == "-").strip("-") or "seating-plan"
    slug = base
    idx = 2
    while SeatingPlan.objects.filter(scope_organizer=organizer, slug=slug).exists():
        slug = f"{base}-{idx}"
        idx += 1
    return slug


def _clone_plan(preset: SeatingPlan, *, name: str, slug: str, is_template: bool) -> SeatingPlan:
    target = SeatingPlan.objects.create(
        scope_organizer=preset.scope_organizer,
        name=name,
        slug=slug,
        description=preset.description,
        width=preset.width,
        height=preset.height,
        grid_size=preset.grid_size,
        snap_enabled=preset.snap_enabled,
        is_template=is_template,
    )
    category_map: dict[int, SeatCategory] = {}
    for category in preset.seat_categories.all():
        new_category = SeatCategory.objects.create(
            plan=target,
            name=category.name,
            code=category.code,
            color=category.color,
            price_rank=category.price_rank,
        )
        category_map[category.id] = new_category

    for seat in preset.seats.all():
        SeatDefinition.objects.create(
            plan=target,
            external_id=seat.external_id,
            display_name=seat.display_name,
            block_label=seat.block_label,
            row_label=seat.row_label,
            seat_number=seat.seat_number,
            seat_index=seat.seat_index,
            row_index=seat.row_index,
            x=seat.x,
            y=seat.y,
            rotation=seat.rotation,
            category=category_map.get(seat.category_id),
            seat_type=seat.seat_type,
            is_accessible=seat.is_accessible,
            is_companion=seat.is_companion,
            is_hidden=seat.is_hidden,
            is_blocked=seat.is_blocked,
            is_technical_blocked=seat.is_technical_blocked,
            notes=seat.notes,
            metadata=seat.metadata,
        )

    for asset in preset.template_assets.all():
        copied_asset = SeatingTemplateAsset.objects.create(
            plan=target,
            name=asset.name,
            source_kind=asset.source_kind,
            source_mime=asset.source_mime,
            source_name=asset.source_name,
            width=asset.width,
            height=asset.height,
            x=asset.x,
            y=asset.y,
            scale=asset.scale,
            rotation=asset.rotation,
            opacity=asset.opacity,
            z_index=asset.z_index,
            is_visible=asset.is_visible,
            is_locked=asset.is_locked,
        )
        if asset.image:
            with asset.image.open("rb") as source_fp:
                image_content = ContentFile(source_fp.read())
            copied_asset.image.save(Path(asset.image.name).name, image_content, save=True)
    return target


def _serialize_template_asset(request: HttpRequest, asset: SeatingTemplateAsset) -> dict:
    return {
        "id": asset.id,
        "name": asset.name,
        "source_kind": asset.source_kind,
        "source_name": asset.source_name,
        "source_mime": asset.source_mime,
        "image_url": request.build_absolute_uri(asset.image.url),
        "width": asset.width,
        "height": asset.height,
        "x": asset.x,
        "y": asset.y,
        "scale": asset.scale,
        "rotation": asset.rotation,
        "opacity": asset.opacity,
        "z_index": asset.z_index,
        "is_visible": asset.is_visible,
        "is_locked": asset.is_locked,
    }


def _image_dimensions(content: bytes) -> tuple[int, int]:
    with Image.open(BytesIO(content)) as image:
        return image.size


def _svg_dimensions(content: bytes) -> tuple[int, int]:
    root = ElementTree.fromstring(content)
    width_raw = root.get("width", "") or ""
    height_raw = root.get("height", "") or ""

    def _num(value: str) -> int | None:
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value)
        if not match:
            return None
        return int(float(match.group(1)))

    width_val = _num(width_raw)
    height_val = _num(height_raw)
    if width_val and height_val:
        return width_val, height_val

    view_box = root.get("viewBox", "") or ""
    if view_box:
        parts = [p for p in re.split(r"[,\s]+", view_box.strip()) if p]
        if len(parts) == 4:
            try:
                return int(float(parts[2])), int(float(parts[3]))
            except ValueError:
                pass
    return 1000, 600


def _pdf_to_png_content(pdf_content: bytes) -> tuple[ContentFile, int, int]:
    try:
        import pypdfium2  # type: ignore
    except Exception as exc:
        raise RuntimeError("PDF support is unavailable: pypdfium2 is missing.") from exc

    pdf = pypdfium2.PdfDocument(pdf_content)
    if len(pdf) < 1:
        raise ValueError("PDF does not contain any pages.")
    page = pdf[0]
    pil_image = page.render(scale=2).to_pil()
    output = BytesIO()
    pil_image.save(output, format="PNG")
    png_bytes = output.getvalue()
    width, height = pil_image.size
    return ContentFile(png_bytes), width, height


@login_required
def plan_list(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    mappings = (
        EventSeatPlanMapping.objects.select_related("plan")
        .filter(event=event_obj, subevent__isnull=True)
        .order_by("plan__name")
    )
    plans = SeatingPlan.objects.filter(scope_organizer=event_obj.organizer, is_template=False).order_by("name")
    presets = SeatingPlan.objects.filter(scope_organizer=event_obj.organizer, is_template=True).order_by("name")
    return render(
        request,
        "pretix_smartseating/control/plan_list.html",
        {"event": event_obj, "plans": plans, "mappings": mappings, "presets": presets},
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
@require_http_methods(["POST"])
def plan_create_from_preset(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    preset_id = request.POST.get("preset_id")
    if not preset_id:
        messages.error(request, "Please select a preset.")
        return redirect(
            reverse("plugins:pretix_smartseating:control.plan_list", kwargs={"organizer": organizer, "event": event})
        )
    preset = get_object_or_404(
        SeatingPlan,
        id=int(preset_id),
        scope_organizer=event_obj.organizer,
        is_template=True,
    )
    target_name = (request.POST.get("name") or f"{preset.name} ({event_obj.slug})").strip()
    target_slug = _unique_slug(event_obj.organizer, request.POST.get("slug") or preset.slug)
    target = _clone_plan(preset, name=target_name, slug=target_slug, is_template=False)
    EventSeatPlanMapping.objects.get_or_create(event=event_obj, subevent=None, defaults={"plan": target})
    messages.success(request, f"Created seating plan '{target.name}' from preset '{preset.name}'.")
    return redirect(
        reverse(
            "plugins:pretix_smartseating:control.plan_editor",
            kwargs={"organizer": organizer, "event": event, "plan_id": target.id},
        )
    )


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
def plan_save_as_preset(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    preset_name = (request.POST.get("name") or f"{plan.name} preset").strip()
    preset_slug = _unique_slug(event_obj.organizer, request.POST.get("slug") or f"{plan.slug}-preset")
    preset = _clone_plan(plan, name=preset_name, slug=preset_slug, is_template=True)
    messages.success(request, f"Preset '{preset.name}' has been created.")
    return redirect(
        reverse(
            "plugins:pretix_smartseating:control.plan_editor",
            kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
        )
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


@login_required
@require_http_methods(["GET"])
def plan_template_assets(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    assets = [
        _serialize_template_asset(request, asset)
        for asset in plan.template_assets.all()
    ]
    return JsonResponse({"ok": True, "assets": assets})


@login_required
@require_http_methods(["POST"])
def plan_template_asset_upload(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    upload = request.FILES.get("file")
    if not upload:
        return JsonResponse({"ok": False, "message": "No file provided."}, status=400)
    if upload.size > MAX_TEMPLATE_UPLOAD_BYTES:
        return JsonResponse({"ok": False, "message": "File is too large."}, status=400)

    file_name = upload.name or "template"
    source_mime = upload.content_type or ""
    content = upload.read()
    requested_name = (request.POST.get("name") or "").strip() or file_name
    source_kind = SeatingTemplateAsset.SourceKind.IMAGE

    try:
        if file_name.lower().endswith(".pdf") or source_mime == "application/pdf":
            source_kind = SeatingTemplateAsset.SourceKind.PDF
            png_content, width, height = _pdf_to_png_content(content)
            output_name = f"{file_name.rsplit('.', 1)[0]}-page1.png"
            asset = SeatingTemplateAsset.objects.create(
                plan=plan,
                name=requested_name,
                source_kind=source_kind,
                source_name=file_name,
                source_mime=source_mime or "application/pdf",
                width=width,
                height=height,
                z_index=plan.template_assets.count(),
            )
            asset.image.save(output_name, png_content, save=True)
        else:
            if file_name.lower().endswith(".svg") or source_mime == "image/svg+xml":
                width, height = _svg_dimensions(content)
            else:
                width, height = _image_dimensions(content)
            image_content = ContentFile(content)
            asset = SeatingTemplateAsset.objects.create(
                plan=plan,
                name=requested_name,
                source_kind=source_kind,
                source_name=file_name,
                source_mime=source_mime,
                width=width,
                height=height,
                z_index=plan.template_assets.count(),
            )
            asset.image.save(file_name, image_content, save=True)
    except Exception as exc:
        return JsonResponse({"ok": False, "message": str(exc)}, status=400)

    return JsonResponse({"ok": True, "asset": _serialize_template_asset(request, asset)})


@login_required
@require_http_methods(["POST"])
def plan_template_asset_update(
    request: HttpRequest,
    organizer: str,
    event: str,
    plan_id: int,
    asset_id: int,
) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    asset = get_object_or_404(SeatingTemplateAsset, id=asset_id, plan=plan)
    try:
        payload = json.loads(request.body.decode("utf-8"))
    except Exception:
        return JsonResponse({"ok": False, "message": "Invalid JSON payload."}, status=400)

    if "name" in payload:
        asset.name = str(payload["name"])[:190]
    if "x" in payload:
        asset.x = float(payload["x"])
    if "y" in payload:
        asset.y = float(payload["y"])
    if "scale" in payload:
        asset.scale = max(0.05, min(20.0, float(payload["scale"])))
    if "rotation" in payload:
        asset.rotation = float(payload["rotation"])
    if "opacity" in payload:
        asset.opacity = max(0.0, min(1.0, float(payload["opacity"])))
    if "z_index" in payload:
        asset.z_index = int(payload["z_index"])
    if "is_visible" in payload:
        asset.is_visible = bool(payload["is_visible"])
    if "is_locked" in payload:
        asset.is_locked = bool(payload["is_locked"])
    asset.save()
    return JsonResponse({"ok": True, "asset": _serialize_template_asset(request, asset)})


@login_required
@require_http_methods(["POST"])
def plan_template_asset_delete(
    request: HttpRequest,
    organizer: str,
    event: str,
    plan_id: int,
    asset_id: int,
) -> JsonResponse:
    event_obj = _event_from_url(organizer, event)
    plan = get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=event_obj.organizer)
    asset = get_object_or_404(SeatingTemplateAsset, id=asset_id, plan=plan)
    asset.image.delete(save=False)
    asset.delete()
    return JsonResponse({"ok": True})
