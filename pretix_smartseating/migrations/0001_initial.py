from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("base", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="SeatingPlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=190)),
                ("slug", models.SlugField(max_length=190)),
                ("description", models.TextField(blank=True)),
                ("width", models.PositiveIntegerField(default=2000)),
                ("height", models.PositiveIntegerField(default=1200)),
                ("grid_size", models.PositiveIntegerField(default=10)),
                ("snap_enabled", models.BooleanField(default=True)),
                ("is_template", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "scope_organizer",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_plans",
                        to="base.organizer",
                    ),
                ),
            ],
            options={"ordering": ["name"], "unique_together": {("scope_organizer", "slug")}},
        ),
        migrations.CreateModel(
            name="SeatCategory",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                ("code", models.SlugField(max_length=80)),
                ("color", models.CharField(default="#3B82F6", max_length=7)),
                ("price_rank", models.PositiveIntegerField(default=100)),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="seat_categories",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
            ],
            options={"ordering": ["price_rank", "name"], "unique_together": {("plan", "code")}},
        ),
        migrations.CreateModel(
            name="SeatingArea",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                ("code", models.SlugField(max_length=80)),
                ("x", models.FloatField(default=0)),
                ("y", models.FloatField(default=0)),
                ("width", models.FloatField(default=100)),
                ("height", models.FloatField(default=100)),
                ("rotation", models.FloatField(default=0)),
                ("is_accessible_zone", models.BooleanField(default=False)),
                ("sort_order", models.PositiveIntegerField(default=0)),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="areas",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
            ],
            options={"ordering": ["sort_order", "name"], "unique_together": {("plan", "code")}},
        ),
        migrations.CreateModel(
            name="SeatingRow",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("label", models.CharField(max_length=30)),
                ("row_index", models.IntegerField(default=0)),
                ("y", models.FloatField(default=0)),
                ("curvature", models.FloatField(default=0)),
                (
                    "area",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="rows",
                        to="pretix_smartseating.seatingarea",
                    ),
                ),
            ],
            options={"ordering": ["row_index", "label"], "unique_together": {("area", "label")}},
        ),
        migrations.CreateModel(
            name="SeatingPlanVersion",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("version_number", models.PositiveIntegerField()),
                ("layout_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("changelog", models.TextField(blank=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="versions",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
            ],
            options={"ordering": ["-version_number"], "unique_together": {("plan", "version_number")}},
        ),
        migrations.CreateModel(
            name="SeatDefinition",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("guid", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("external_id", models.CharField(max_length=120)),
                ("display_name", models.CharField(blank=True, max_length=190)),
                ("block_label", models.CharField(blank=True, max_length=30)),
                ("row_label", models.CharField(blank=True, max_length=30)),
                ("seat_number", models.CharField(max_length=30)),
                ("seat_index", models.IntegerField(default=0)),
                ("row_index", models.IntegerField(default=0)),
                ("x", models.FloatField()),
                ("y", models.FloatField()),
                ("rotation", models.FloatField(default=0)),
                (
                    "seat_type",
                    models.CharField(
                        choices=[
                            ("normal", "Normal"),
                            ("wheelchair", "Wheelchair"),
                            ("companion", "Companion"),
                            ("technical", "Technical"),
                            ("vip", "VIP"),
                        ],
                        default="normal",
                        max_length=20,
                    ),
                ),
                ("is_accessible", models.BooleanField(default=False)),
                ("is_companion", models.BooleanField(default=False)),
                ("is_hidden", models.BooleanField(default=False)),
                ("is_blocked", models.BooleanField(default=False)),
                ("is_technical_blocked", models.BooleanField(default=False)),
                ("notes", models.TextField(blank=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                (
                    "area",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="seats",
                        to="pretix_smartseating.seatingarea",
                    ),
                ),
                (
                    "category",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        to="pretix_smartseating.seatcategory",
                    ),
                ),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="seats",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
                (
                    "row",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="seats",
                        to="pretix_smartseating.seatingrow",
                    ),
                ),
            ],
            options={"ordering": ["block_label", "row_index", "seat_index"]},
        ),
        migrations.CreateModel(
            name="EventSeatPlanMapping",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("allow_nearby_mode", models.BooleanField(default=True)),
                ("prefer_center", models.BooleanField(default=True)),
                ("prefer_front", models.BooleanField(default=False)),
                ("hold_timeout_seconds", models.PositiveIntegerField(default=600)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "active_version",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="pretix_smartseating.seatingplanversion",
                    ),
                ),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_mappings",
                        to="base.event",
                    ),
                ),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="event_mappings",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
                (
                    "subevent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_mappings",
                        to="base.subevent",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="SeatAuditLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "action",
                    models.CharField(
                        choices=[
                            ("plan_updated", "Plan updated"),
                            ("bulk_edit", "Bulk edit"),
                            ("hold_created", "Hold created"),
                            ("hold_released", "Hold released"),
                            ("autoseat_assigned", "Auto seat assigned"),
                            ("status_changed", "Status changed"),
                        ],
                        max_length=40,
                    ),
                ),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "event",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_audit",
                        to="base.event",
                    ),
                ),
                (
                    "seat",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="audit_entries",
                        to="pretix_smartseating.seatdefinition",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="SeatState",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("available", "Available"),
                            ("hold", "Hold"),
                            ("sold", "Sold"),
                            ("blocked", "Blocked"),
                            ("technical", "Technical"),
                        ],
                        default="available",
                        max_length=20,
                    ),
                ),
                ("hold_token", models.UUIDField(blank=True, null=True)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("order_code", models.CharField(blank=True, max_length=120)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_states",
                        to="base.event",
                    ),
                ),
                (
                    "seat",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="states",
                        to="pretix_smartseating.seatdefinition",
                    ),
                ),
                (
                    "subevent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_states",
                        to="base.subevent",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="SeatHold",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("token", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False)),
                ("acquired_at", models.DateTimeField(auto_now_add=True)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("customer_ref", models.CharField(blank=True, max_length=190)),
                ("reason", models.CharField(blank=True, max_length=120)),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_holds",
                        to="base.event",
                    ),
                ),
                (
                    "seat",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="holds",
                        to="pretix_smartseating.seatdefinition",
                    ),
                ),
                (
                    "subevent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="smartseat_holds",
                        to="base.subevent",
                    ),
                ),
            ],
        ),
        migrations.AddIndex(
            model_name="seatdefinition",
            index=models.Index(fields=["plan", "block_label", "row_label", "seat_index"], name="smartseat_s_plan_id_8016a4_idx"),
        ),
        migrations.AddIndex(
            model_name="seatdefinition",
            index=models.Index(fields=["plan", "external_id"], name="smartseat_s_plan_id_4de5f5_idx"),
        ),
        migrations.AddConstraint(
            model_name="seatdefinition",
            constraint=models.UniqueConstraint(
                fields=("plan", "external_id"),
                name="smartseat_unique_external_id",
            ),
        ),
        migrations.AddConstraint(
            model_name="seatdefinition",
            constraint=models.UniqueConstraint(
                fields=("plan", "block_label", "row_label", "seat_number"),
                name="smartseat_unique_visible_position",
            ),
        ),
        migrations.AddConstraint(
            model_name="eventseatplanmapping",
            constraint=models.UniqueConstraint(
                fields=("event", "subevent"),
                name="smartseat_unique_mapping_per_event_subevent",
            ),
        ),
        migrations.AddConstraint(
            model_name="seatstate",
            constraint=models.UniqueConstraint(
                fields=("event", "subevent", "seat"),
                name="smartseat_unique_event_seat_state",
            ),
        ),
        migrations.AddIndex(
            model_name="seatstate",
            index=models.Index(
                fields=["event", "subevent", "status", "expires_at"],
                name="smartseat_s_event_i_7fc3c5_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="seathold",
            constraint=models.UniqueConstraint(
                fields=("event", "subevent", "seat", "token"),
                name="smartseat_unique_hold_entry",
            ),
        ),
        migrations.AddIndex(
            model_name="seathold",
            index=models.Index(
                fields=["event", "subevent", "seat", "expires_at"],
                name="smartseat_s_event_i_d85999_idx",
            ),
        ),
    ]
