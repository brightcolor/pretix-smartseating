import uuid
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import Q
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


class SeatState(models.Model):
    class Status(models.TextChoices):
        AVAILABLE = "available", _("Available")
        HOLD = "hold", _("Hold")
        SOLD = "sold", _("Sold")
        BLOCKED = "blocked", _("Blocked")
        TECHNICAL = "technical", _("Technical")

    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="smartseat_states")
    subevent = models.ForeignKey(
        SubEvent, null=True, blank=True, on_delete=models.CASCADE, related_name="smartseat_states"
    )
    seat = models.ForeignKey(SeatDefinition, on_delete=models.CASCADE, related_name="states")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.AVAILABLE)
    hold_token = models.UUIDField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    order_code = models.CharField(max_length=120, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["event", "subevent", "seat"], name="smartseat_unique_event_seat_state")
        ]
        indexes = [models.Index(fields=["event", "subevent", "status", "expires_at"])]

    @property
    def is_expired(self) -> bool:
        return bool(self.expires_at and self.expires_at <= timezone.now())


class SeatHold(models.Model):
    token = models.UUIDField(default=uuid.uuid4, editable=False, db_index=True)
    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="smartseat_holds")
    subevent = models.ForeignKey(
        SubEvent, null=True, blank=True, on_delete=models.CASCADE, related_name="smartseat_holds"
    )
    seat = models.ForeignKey(SeatDefinition, on_delete=models.CASCADE, related_name="holds")
    acquired_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)
    customer_ref = models.CharField(max_length=190, blank=True)
    reason = models.CharField(max_length=120, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["event", "subevent", "seat", "token"],
                name="smartseat_unique_hold_entry",
            )
        ]
        indexes = [models.Index(fields=["event", "subevent", "seat", "expires_at"])]

    @property
    def is_active(self) -> bool:
        return self.expires_at > timezone.now()


class SeatAuditLog(models.Model):
    class Action(models.TextChoices):
        PLAN_UPDATED = "plan_updated", _("Plan updated")
        BULK_EDIT = "bulk_edit", _("Bulk edit")
        HOLD_CREATED = "hold_created", _("Hold created")
        HOLD_RELEASED = "hold_released", _("Hold released")
        AUTOSEAT_ASSIGNED = "autoseat_assigned", _("Auto seat assigned")
        STATUS_CHANGED = "status_changed", _("Status changed")

    event = models.ForeignKey(Event, null=True, blank=True, on_delete=models.CASCADE, related_name="smartseat_audit")
    seat = models.ForeignKey(
        SeatDefinition, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_entries"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    action = models.CharField(max_length=40, choices=Action.choices)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


def release_expired_states_for_event(event: Event, subevent: SubEvent | None = None) -> int:
    now = timezone.now()
    with transaction.atomic():
        query = SeatState.objects.select_for_update().filter(
            event=event,
            subevent=subevent,
            status=SeatState.Status.HOLD,
            expires_at__lte=now,
        )
        affected = query.count()
        query.update(
            status=SeatState.Status.AVAILABLE,
            hold_token=None,
            expires_at=None,
        )
    return affected


def purge_expired_holds(event: Event, subevent: SubEvent | None = None) -> int:
    now = timezone.now()
    query = SeatHold.objects.filter(event=event, subevent=subevent, expires_at__lte=now)
    count = query.count()
    query.delete()
    return count


def get_or_create_state(event: Event, subevent: SubEvent | None, seat: SeatDefinition) -> SeatState:
    state, _ = SeatState.objects.get_or_create(
        event=event,
        subevent=subevent,
        seat=seat,
        defaults={"status": SeatState.Status.AVAILABLE},
    )
    if state.status == SeatState.Status.HOLD and state.is_expired:
        state.status = SeatState.Status.AVAILABLE
        state.hold_token = None
        state.expires_at = None
        state.save(update_fields=["status", "hold_token", "expires_at", "updated_at"])
    return state


def get_effective_status(
    seat: SeatDefinition,
    event: Event,
    subevent: SubEvent | None = None,
) -> str:
    if seat.is_technical_blocked:
        return str(SeatState.Status.TECHNICAL)
    if seat.is_blocked:
        return str(SeatState.Status.BLOCKED)
    state = SeatState.objects.filter(event=event, subevent=subevent, seat=seat).first()
    if not state:
        return str(SeatState.Status.AVAILABLE)
    if state.status == SeatState.Status.HOLD and state.is_expired:
        return str(SeatState.Status.AVAILABLE)
    return state.status


def state_filter_q(event: Event, subevent: SubEvent | None = None) -> Q:
    return Q(event=event, subevent=subevent)
