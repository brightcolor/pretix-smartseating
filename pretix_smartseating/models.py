import uuid
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Event, Organizer, SubEvent


class SeatingPlan(models.Model):
    scope_organizer = models.ForeignKey(
        Organizer,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="smartseat_plans",
    )
    name = models.CharField(max_length=190)
    slug = models.SlugField(max_length=190)
    description = models.TextField(blank=True)
    width = models.PositiveIntegerField(default=2000)
    height = models.PositiveIntegerField(default=1200)
    grid_size = models.PositiveIntegerField(default=10)
    snap_enabled = models.BooleanField(default=True)
    is_template = models.BooleanField(default=False)
    # Decorative / structural areas (stage, bar, aisles, text labels). Stored as
    # a list of dicts compatible with pretix' native seating "areas" objects:
    #   {shape, position:{x,y}, rotation, color, border_color, rectangle/circle/
    #    ellipse/polygon/text:{...}}
    # NB: named area_shapes (not "areas") to avoid clashing with the SeatingArea
    # reverse accessor (related_name="areas"). The JSON key stays "areas".
    area_shapes = models.JSONField(default=list, blank=True)
    # Link to the native pretix seating plan generated from this editor plan.
    # When set, pretix core owns checkout/holds/orders for the mapped event(s).
    pretix_plan = models.OneToOneField(
        "pretixbase.SeatingPlan",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = (("scope_organizer", "slug"),)
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class SeatingPlanVersion(models.Model):
    plan = models.ForeignKey(SeatingPlan, on_delete=models.CASCADE, related_name="versions")
    version_number = models.PositiveIntegerField()
    layout_json = models.JSONField(default=dict)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    changelog = models.TextField(blank=True)

    class Meta:
        unique_together = (("plan", "version_number"),)
        ordering = ["-version_number"]


class SeatCategory(models.Model):
    plan = models.ForeignKey(SeatingPlan, on_delete=models.CASCADE, related_name="seat_categories")
    name = models.CharField(max_length=120)
    code = models.SlugField(max_length=80)
    color = models.CharField(max_length=7, default="#3B82F6")
    price_rank = models.PositiveIntegerField(default=100)

    class Meta:
        unique_together = (("plan", "code"),)
        ordering = ["price_rank", "name"]

    def __str__(self) -> str:
        return f"{self.plan.slug}:{self.code}"


class SeatingArea(models.Model):
    plan = models.ForeignKey(SeatingPlan, on_delete=models.CASCADE, related_name="areas")
    name = models.CharField(max_length=120)
    code = models.SlugField(max_length=80)
    x = models.FloatField(default=0)
    y = models.FloatField(default=0)
    width = models.FloatField(default=100)
    height = models.FloatField(default=100)
    rotation = models.FloatField(default=0)
    is_accessible_zone = models.BooleanField(default=False)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = (("plan", "code"),)
        ordering = ["sort_order", "name"]


class SeatingRow(models.Model):
    area = models.ForeignKey(SeatingArea, on_delete=models.CASCADE, related_name="rows")
    label = models.CharField(max_length=30)
    row_index = models.IntegerField(default=0)
    y = models.FloatField(default=0)
    curvature = models.FloatField(default=0)

    class Meta:
        unique_together = (("area", "label"),)
        ordering = ["row_index", "label"]


class SeatDefinition(models.Model):
    class SeatType(models.TextChoices):
        NORMAL = "normal", _("Normal")
        WHEELCHAIR = "wheelchair", _("Wheelchair")
        COMPANION = "companion", _("Companion")
        TECHNICAL = "technical", _("Technical")
        VIP = "vip", _("VIP")

    plan = models.ForeignKey(SeatingPlan, on_delete=models.CASCADE, related_name="seats")
    area = models.ForeignKey(SeatingArea, null=True, blank=True, on_delete=models.SET_NULL, related_name="seats")
    row = models.ForeignKey(SeatingRow, null=True, blank=True, on_delete=models.SET_NULL, related_name="seats")
    guid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    external_id = models.CharField(max_length=120)
    display_name = models.CharField(max_length=190, blank=True)
    block_label = models.CharField(max_length=30, blank=True)
    row_label = models.CharField(max_length=30, blank=True)
    seat_number = models.CharField(max_length=30)
    seat_index = models.IntegerField(default=0)
    row_index = models.IntegerField(default=0)
    x = models.FloatField()
    y = models.FloatField()
    rotation = models.FloatField(default=0)
    category = models.ForeignKey(SeatCategory, null=True, blank=True, on_delete=models.SET_NULL)
    seat_type = models.CharField(max_length=20, choices=SeatType.choices, default=SeatType.NORMAL)
    is_accessible = models.BooleanField(default=False)
    is_companion = models.BooleanField(default=False)
    is_hidden = models.BooleanField(default=False)
    is_blocked = models.BooleanField(default=False)
    is_technical_blocked = models.BooleanField(default=False)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["plan", "block_label", "row_label", "seat_index"]),
            models.Index(fields=["plan", "external_id"]),
        ]
        constraints = [
            models.UniqueConstraint(fields=["plan", "external_id"], name="smartseat_unique_external_id"),
            models.UniqueConstraint(
                fields=["plan", "block_label", "row_label", "seat_number"],
                name="smartseat_unique_visible_position",
            ),
        ]
        ordering = ["block_label", "row_index", "seat_index"]

    def clean(self):
        if self.category and self.category.plan_id != self.plan_id:
            raise ValidationError(_("Seat category must belong to the same seating plan."))

    def __str__(self) -> str:
        return f"{self.block_label}-{self.row_label}-{self.seat_number}"


class SeatingTemplateAsset(models.Model):
    class SourceKind(models.TextChoices):
        IMAGE = "image", _("Image")
        PDF = "pdf", _("PDF")

    plan = models.ForeignKey(SeatingPlan, on_delete=models.CASCADE, related_name="template_assets")
    name = models.CharField(max_length=190)
    source_kind = models.CharField(max_length=20, choices=SourceKind.choices, default=SourceKind.IMAGE)
    source_mime = models.CharField(max_length=120, blank=True)
    source_name = models.CharField(max_length=255, blank=True)
    image = models.ImageField(upload_to="smartseating/templates/")
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    x = models.FloatField(default=0)
    y = models.FloatField(default=0)
    scale = models.FloatField(default=1.0, validators=[MinValueValidator(0.05), MaxValueValidator(20.0)])
    rotation = models.FloatField(default=0.0)
    opacity = models.FloatField(default=0.35, validators=[MinValueValidator(0.0), MaxValueValidator(1.0)])
    z_index = models.IntegerField(default=0)
    is_visible = models.BooleanField(default=True)
    is_locked = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["z_index", "id"]


class EventSeatPlanMapping(models.Model):
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="smartseat_mappings")
    subevent = models.ForeignKey(
        SubEvent,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="smartseat_mappings",
    )
    plan = models.ForeignKey(SeatingPlan, on_delete=models.PROTECT, related_name="event_mappings")
    active_version = models.ForeignKey(
        SeatingPlanVersion,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    allow_nearby_mode = models.BooleanField(default=True)
    prefer_center = models.BooleanField(default=True)
    prefer_front = models.BooleanField(default=False)
    hold_timeout_seconds = models.PositiveIntegerField(default=600)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["event", "subevent"],
                name="smartseat_unique_mapping_per_event_subevent",
            ),
        ]

    def clean(self):
        if self.subevent and self.subevent.event_id != self.event_id:
            raise ValidationError(_("Subevent must belong to event."))

    def get_hold_expiry(self):
        return timezone.now() + timedelta(seconds=self.hold_timeout_seconds)
