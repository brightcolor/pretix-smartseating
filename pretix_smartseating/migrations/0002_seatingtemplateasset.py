from django.core import validators
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("pretix_smartseating", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="SeatingTemplateAsset",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=190)),
                (
                    "source_kind",
                    models.CharField(
                        choices=[("image", "Image"), ("pdf", "PDF")],
                        default="image",
                        max_length=20,
                    ),
                ),
                ("source_mime", models.CharField(blank=True, max_length=120)),
                ("source_name", models.CharField(blank=True, max_length=255)),
                ("image", models.ImageField(upload_to="smartseating/templates/")),
                ("width", models.PositiveIntegerField(default=0)),
                ("height", models.PositiveIntegerField(default=0)),
                ("x", models.FloatField(default=0)),
                ("y", models.FloatField(default=0)),
                (
                    "scale",
                    models.FloatField(
                        default=1.0,
                        validators=[validators.MinValueValidator(0.05), validators.MaxValueValidator(20.0)],
                    ),
                ),
                ("rotation", models.FloatField(default=0.0)),
                (
                    "opacity",
                    models.FloatField(
                        default=0.35,
                        validators=[validators.MinValueValidator(0.0), validators.MaxValueValidator(1.0)],
                    ),
                ),
                ("z_index", models.IntegerField(default=0)),
                ("is_visible", models.BooleanField(default=True)),
                ("is_locked", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="template_assets",
                        to="pretix_smartseating.seatingplan",
                    ),
                ),
            ],
            options={"ordering": ["z_index", "id"]},
        ),
    ]

