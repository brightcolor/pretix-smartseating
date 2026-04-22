from django.contrib import admin

from pretix_smartseating import models


@admin.register(models.SeatingPlan)
class SeatingPlanAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "slug", "scope_organizer", "updated_at")
    search_fields = ("name", "slug")


@admin.register(models.SeatDefinition)
class SeatDefinitionAdmin(admin.ModelAdmin):
    list_display = ("id", "plan", "block_label", "row_label", "seat_number", "category", "is_blocked")
    list_filter = ("plan", "category", "is_accessible", "is_blocked", "is_technical_blocked")
    search_fields = ("external_id", "display_name", "row_label", "seat_number")


@admin.register(models.EventSeatPlanMapping)
class EventSeatPlanMappingAdmin(admin.ModelAdmin):
    list_display = ("id", "event", "subevent", "plan", "hold_timeout_seconds", "updated_at")
    list_filter = ("event",)


@admin.register(models.SeatingTemplateAsset)
class SeatingTemplateAssetAdmin(admin.ModelAdmin):
    list_display = ("id", "plan", "name", "source_kind", "z_index", "is_visible", "is_locked", "updated_at")
    list_filter = ("source_kind", "is_visible", "is_locked")
    search_fields = ("name", "source_name")
