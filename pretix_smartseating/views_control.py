import json
import re
from io import BytesIO
from pathlib import Path

from defusedxml import ElementTree as SafeET
from django.contrib import messages
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.decorators.http import require_http_methods
from PIL import Image, UnidentifiedImageError
from pretix.base.models import SubEvent
from pretix.control.permissions import event_permission_required

from pretix_smartseating.forms import ImportPlanForm, SeatingPlanForm
from pretix_smartseating.models import (
    EventSeatPlanMapping,
    SeatCategory,
    SeatDefinition,
    SeatingPlan,
    SeatingTemplateAsset,
)
from pretix_smartseating.services.import_export import export_plan, import_plan
from pretix_smartseating.services.native import (
    DEFAULT_CATEGORY_NAME,
    SeatProtected,
    build_pretix_layout,
    layout_from_pretix,
    sync_plan_to_event,
)

# Hard caps for untrusted background-plan uploads.
MAX_TEMPLATE_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000  # ~40 MP, guards against decompression bombs
MAX_JSON_BODY_BYTES = 5 * 1024 * 1024

# Pillow's own bomb guard; keep it a touch above our explicit check.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS + 1_000_000

ALLOWED_RASTER_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
ALLOWED_RASTER_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif"}

# SVG elements/attributes that can execute script or load remote content.
_SVG_FORBIDDEN_TAGS = {"script", "foreignobject", "iframe", "embed", "object", "animate",
                       "set", "handler", "use"}
_SVG_FORBIDDEN_ATTR_PREFIXES = ("on",)
_SVG_FORBIDDEN_ATTR_VALUES = re.compile(r"(javascript:|data:text/html)", re.IGNORECASE)


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _plan_for_event(request: HttpRequest, plan_id: int) -> SeatingPlan:
    # Scope every plan lookup to the organizer the permission check passed for,
    # so a valid plan_id from another organizer cannot be reached.
    return get_object_or_404(SeatingPlan, id=plan_id, scope_organizer=request.organizer)


def _read_json_body(request: HttpRequest) -> dict:
    body = request.body or b""
    if len(body) > MAX_JSON_BODY_BYTES:
        raise ValueError("Request body is too large.")
    return json.loads(body.decode("utf-8")) if body else {}


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
        area_shapes=list(preset.area_shapes or []),
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


def _verify_raster(content: bytes) -> tuple[int, int]:
    """Validate that the bytes are a real, sanely-sized raster image."""
    try:
        with Image.open(BytesIO(content)) as probe:
            probe.verify()  # detects truncated/forged images
        with Image.open(BytesIO(content)) as image:
            width, height = image.size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError(_("The uploaded file is not a valid image.")) from exc
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError(_("The uploaded image exceeds the maximum allowed resolution."))
    return width, height


def _sanitize_svg(content: bytes) -> tuple[bytes, tuple[int, int]]:
    """Parse the SVG defensively (no XXE/entity expansion), strip scriptable
    constructs and re-serialize. Returns sanitized bytes and dimensions."""
    try:
        root = SafeET.fromstring(content)
    except SafeET.ParseError as exc:
        raise ValueError(_("The uploaded SVG could not be parsed.")) from exc
    except Exception as exc:  # defusedxml raises on entity-expansion attacks
        raise ValueError(_("The uploaded SVG was rejected for security reasons.")) from exc

    def scrub(element):
        for attr in list(element.attrib):
            local = attr.rsplit("}", 1)[-1].lower()
            value = element.attrib[attr]
            if local.startswith(_SVG_FORBIDDEN_ATTR_PREFIXES) or _SVG_FORBIDDEN_ATTR_VALUES.search(value or ""):
                del element.attrib[attr]
        for child in list(element):
            if _local_tag(child.tag) in _SVG_FORBIDDEN_TAGS:
                element.remove(child)
            else:
                scrub(child)

    scrub(root)
    sanitized = SafeET.tostring(root)
    if isinstance(sanitized, str):
        sanitized = sanitized.encode("utf-8")
    width, height = _svg_dimensions(root)
    return sanitized, (width, height)


def _svg_dimensions(root) -> tuple[int, int]:
    def _num(value: str) -> int | None:
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value or "")
        return int(float(match.group(1))) if match else None

    width_val = _num(root.get("width", ""))
    height_val = _num(root.get("height", ""))
    if width_val and height_val:
        return width_val, height_val
    view_box = root.get("viewBox", "") or ""
    parts = [p for p in re.split(r"[,\s]+", view_box.strip()) if p]
    if len(parts) == 4:
        try:
            return int(float(parts[2])), int(float(parts[3]))
        except ValueError:
            pass
    return 1000, 600


def _pdf_to_png_content(pdf_content: bytes) -> tuple[ContentFile, int, int]:
    try:
        import pypdfium2
    except Exception as exc:
        raise RuntimeError(_("PDF support is unavailable: pypdfium2 is missing.")) from exc

    pdf = pypdfium2.PdfDocument(pdf_content)
    if len(pdf) < 1:
        raise ValueError(_("PDF does not contain any pages."))
    page = pdf[0]
    pil_image = page.render(scale=2).to_pil()
    if pil_image.width * pil_image.height > MAX_IMAGE_PIXELS:
        raise ValueError(_("The rendered PDF page exceeds the maximum allowed resolution."))
    output = BytesIO()
    pil_image.save(output, format="PNG")
    return ContentFile(output.getvalue()), pil_image.width, pil_image.height


@event_permission_required("can_change_event_settings")
def plan_list(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = request.event
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


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET", "POST"])
def plan_create(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = request.event
    if request.method == "POST":
        form = SeatingPlanForm(request.POST)
        if form.is_valid():
            plan = form.save(commit=False)
            plan.scope_organizer = event_obj.organizer
            plan.save()
            EventSeatPlanMapping.objects.get_or_create(event=event_obj, subevent=None, defaults={"plan": plan})
            messages.success(request, _("Seating plan created."))
            return redirect(
                reverse(
                    "plugins:pretix_smartseating:control.plan_editor",
                    kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
                )
            )
    else:
        form = SeatingPlanForm()
    return render(request, "pretix_smartseating/control/plan_form.html", {"form": form, "event": event_obj})


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_create_from_preset(request: HttpRequest, organizer: str, event: str) -> HttpResponse:
    event_obj = request.event
    preset_id = request.POST.get("preset_id")
    if not preset_id:
        messages.error(request, _("Please select a preset."))
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
    messages.success(request, _("Created seating plan '{name}' from preset '{preset}'.").format(
        name=target.name, preset=preset.name))
    return redirect(
        reverse(
            "plugins:pretix_smartseating:control.plan_editor",
            kwargs={"organizer": organizer, "event": event, "plan_id": target.id},
        )
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET"])
def plan_editor(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    plan = _plan_for_event(request, plan_id)
    return render(
        request,
        "pretix_smartseating/control/editor.html",
        {"event": request.event, "plan": plan},
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_save_as_preset(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    plan = _plan_for_event(request, plan_id)
    preset_name = (request.POST.get("name") or f"{plan.name} preset").strip()
    preset_slug = _unique_slug(request.organizer, request.POST.get("slug") or f"{plan.slug}-preset")
    preset = _clone_plan(plan, name=preset_name, slug=preset_slug, is_template=True)
    messages.success(request, _("Preset '{name}' has been created.").format(name=preset.name))
    return redirect(
        reverse(
            "plugins:pretix_smartseating:control.plan_editor",
            kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
        )
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_save_layout(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    try:
        payload = _read_json_body(request)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return JsonResponse({"ok": False, "error": "invalid_payload"}, status=400)
    issues = import_plan(plan, payload, replace_existing=True, save_version=True)
    if issues:
        return JsonResponse({"ok": False, "issues": issues}, status=400)
    return JsonResponse({"ok": True})


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET"])
def plan_export(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    bundle = export_plan(plan)
    return JsonResponse(
        {
            "plan": bundle.plan,
            "categories": bundle.categories,
            "seats": bundle.seats,
            "areas": bundle.areas,
            "metadata": bundle.metadata,
        }
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET"])
def plan_export_native(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    """Download the plan in pretix / seats.pretix.eu native layout format."""
    plan = _plan_for_event(request, plan_id)
    try:
        layout = build_pretix_layout(plan)
    except DjangoValidationError as exc:
        return JsonResponse({"ok": False, "error": "invalid_layout", "detail": str(exc)}, status=400)
    response = JsonResponse(layout, json_dumps_params={"indent": 2})
    response["Content-Disposition"] = f'attachment; filename="{plan.slug}-pretix-layout.json"'
    return response


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET", "POST"])
def plan_import(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    plan = _plan_for_event(request, plan_id)
    if request.method == "POST":
        form = ImportPlanForm(request.POST)
        if form.is_valid():
            payload = form.cleaned_data["payload"]
            # Auto-detect a pretix / seats.pretix.eu layout and convert it.
            if isinstance(payload, dict) and "zones" in payload and "size" in payload:
                try:
                    payload = layout_from_pretix(payload)
                except (ValueError, DjangoValidationError) as exc:
                    messages.error(request, _("Invalid pretix layout: {error}").format(error=str(exc)))
                    payload = None
            if payload is None:
                issues = [{"code": "invalid", "message": "conversion failed"}]
            else:
                issues = import_plan(
                    plan,
                    payload,
                    replace_existing=form.cleaned_data["replace_existing"],
                )
            if issues:
                for issue in issues:
                    messages.error(request, f"{issue['code']}: {issue['message']}")
            else:
                messages.success(request, _("Plan imported."))
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
        {"form": form, "event": request.event, "plan": plan},
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET", "POST"])
def plan_apply(request: HttpRequest, organizer: str, event: str, plan_id: int) -> HttpResponse:
    """Push a local editor plan to pretix' native seating for this (sub)event.

    Lets the user map each editor seat category to a pretix product, then
    delegates holds/checkout/orders to pretix core via ``sync_plan_to_event``.
    """
    plan = _plan_for_event(request, plan_id)
    ev = request.event
    items = list(ev.items.filter(active=True))
    categories = list(plan.seat_categories.all())
    has_uncategorized = plan.seats.filter(category__isnull=True, is_hidden=False).exists()

    # Build the list of layout categories the user must map (code + label).
    mappable = [{"code": c.code, "label": c.name or c.code} for c in categories]
    if has_uncategorized:
        mappable.append({"code": DEFAULT_CATEGORY_NAME, "label": _("Uncategorized seats")})

    subevent = None
    raw_subevent = request.POST.get("subevent") or request.GET.get("subevent")
    if ev.has_subevents and raw_subevent:
        subevent = get_object_or_404(SubEvent, event=ev, pk=int(raw_subevent))

    if request.method == "POST":
        product_map: dict[str, object] = {}
        for entry in mappable:
            value = request.POST.get(f"cat_{entry['code']}")
            if value:
                product_map[entry["code"]] = next((i for i in items if str(i.pk) == value), None)
        try:
            result = sync_plan_to_event(event=ev, plan=plan, product_map=product_map, subevent=subevent)
        except SeatProtected as exc:
            messages.error(request, str(exc))
        except Exception as exc:  # validation / unexpected -> surface, do not 500
            messages.error(request, _("Could not apply the plan: {error}").format(error=str(exc)))
        else:
            messages.success(
                request,
                _("Plan applied: {seats} seats generated ({blocked} blocked). "
                  "Mapped categories: {mapped}. Unmapped: {unmapped}.").format(
                    seats=result.seat_count,
                    blocked=result.blocked_count,
                    mapped=", ".join(result.mapped_categories) or "-",
                    unmapped=", ".join(result.unmapped_categories) or "-",
                ),
            )
            return redirect(
                reverse(
                    "plugins:pretix_smartseating:control.plan_editor",
                    kwargs={"organizer": organizer, "event": event, "plan_id": plan.id},
                )
            )

    return render(
        request,
        "pretix_smartseating/control/plan_apply.html",
        {
            "event": ev,
            "plan": plan,
            "items": items,
            "mappable": mappable,
            "subevents": ev.subevents.all() if ev.has_subevents else [],
            "selected_subevent": subevent,
        },
    )


@event_permission_required("can_change_event_settings")
@require_http_methods(["GET"])
def plan_template_assets(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    assets = [_serialize_template_asset(request, asset) for asset in plan.template_assets.all()]
    return JsonResponse({"ok": True, "assets": assets})


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_template_asset_upload(request: HttpRequest, organizer: str, event: str, plan_id: int) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    upload = request.FILES.get("file")
    if not upload:
        return JsonResponse({"ok": False, "message": "No file provided."}, status=400)
    if upload.size > MAX_TEMPLATE_UPLOAD_BYTES:
        return JsonResponse({"ok": False, "message": "File is too large."}, status=400)

    file_name = upload.name or "template"
    ext = Path(file_name).suffix.lower()
    source_mime = (upload.content_type or "").lower()
    content = upload.read()
    requested_name = (request.POST.get("name") or "").strip() or file_name

    try:
        if ext == ".pdf" or source_mime == "application/pdf":
            png_content, width, height = _pdf_to_png_content(content)
            output_name = f"{Path(file_name).stem}-page1.png"
            asset = SeatingTemplateAsset.objects.create(
                plan=plan,
                name=requested_name,
                source_kind=SeatingTemplateAsset.SourceKind.PDF,
                source_name=file_name,
                source_mime="application/pdf",
                width=width,
                height=height,
                z_index=plan.template_assets.count(),
            )
            asset.image.save(output_name, png_content, save=True)
        elif ext == ".svg" or source_mime == "image/svg+xml":
            sanitized, (width, height) = _sanitize_svg(content)
            asset = SeatingTemplateAsset.objects.create(
                plan=plan,
                name=requested_name,
                source_kind=SeatingTemplateAsset.SourceKind.IMAGE,
                source_name=file_name,
                source_mime="image/svg+xml",
                width=width,
                height=height,
                z_index=plan.template_assets.count(),
            )
            asset.image.save(f"{Path(file_name).stem}.svg", ContentFile(sanitized), save=True)
        elif ext in ALLOWED_RASTER_EXT or source_mime in ALLOWED_RASTER_MIME:
            width, height = _verify_raster(content)
            asset = SeatingTemplateAsset.objects.create(
                plan=plan,
                name=requested_name,
                source_kind=SeatingTemplateAsset.SourceKind.IMAGE,
                source_name=file_name,
                source_mime=source_mime or "application/octet-stream",
                width=width,
                height=height,
                z_index=plan.template_assets.count(),
            )
            asset.image.save(file_name, ContentFile(content), save=True)
        else:
            return JsonResponse(
                {"ok": False, "message": "Unsupported file type. Allowed: PNG, JPG, WEBP, GIF, SVG, PDF."},
                status=400,
            )
    except (ValueError, RuntimeError) as exc:
        return JsonResponse({"ok": False, "message": str(exc)}, status=400)

    return JsonResponse({"ok": True, "asset": _serialize_template_asset(request, asset)})


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_template_asset_update(
    request: HttpRequest, organizer: str, event: str, plan_id: int, asset_id: int
) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    asset = get_object_or_404(SeatingTemplateAsset, id=asset_id, plan=plan)
    try:
        payload = _read_json_body(request)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return JsonResponse({"ok": False, "message": "Invalid JSON payload."}, status=400)

    try:
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
    except (TypeError, ValueError):
        return JsonResponse({"ok": False, "message": "Invalid value in payload."}, status=400)
    asset.save()
    return JsonResponse({"ok": True, "asset": _serialize_template_asset(request, asset)})


@event_permission_required("can_change_event_settings")
@require_http_methods(["POST"])
def plan_template_asset_delete(
    request: HttpRequest, organizer: str, event: str, plan_id: int, asset_id: int
) -> JsonResponse:
    plan = _plan_for_event(request, plan_id)
    asset = get_object_or_404(SeatingTemplateAsset, id=asset_id, plan=plan)
    asset.image.delete(save=False)
    asset.delete()
    return JsonResponse({"ok": True})
