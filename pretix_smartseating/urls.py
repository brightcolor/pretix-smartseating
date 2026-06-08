from django.urls import path

from pretix_smartseating import views_control, views_presale

app_name = "pretix_smartseating"

# All views live under the pretix control area, so the control permission
# middleware sets request.event/organizer and enforces base access, while each
# view additionally requires the can_change_event_settings permission.
urlpatterns = [
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/",
        views_control.plan_list,
        name="control.plan_list",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/new/",
        views_control.plan_create,
        name="control.plan_create",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/new-from-preset/",
        views_control.plan_create_from_preset,
        name="control.plan_create_from_preset",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/",
        views_control.plan_editor,
        name="control.plan_editor",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/save/",
        views_control.plan_save_layout,
        name="control.plan_save_layout",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/save-as-preset/",
        views_control.plan_save_as_preset,
        name="control.plan_save_as_preset",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/apply/",
        views_control.plan_apply,
        name="control.plan_apply",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/import/",
        views_control.plan_import,
        name="control.plan_import",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/export/",
        views_control.plan_export,
        name="control.plan_export",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/export-native/",
        views_control.plan_export_native,
        name="control.plan_export_native",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/assets/",
        views_control.plan_template_assets,
        name="control.plan_template_assets",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/assets/upload/",
        views_control.plan_template_asset_upload,
        name="control.plan_template_asset_upload",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/assets/<int:asset_id>/update/",
        views_control.plan_template_asset_update,
        name="control.plan_template_asset_update",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/assets/<int:asset_id>/delete/",
        views_control.plan_template_asset_delete,
        name="control.plan_template_asset_delete",
    ),
    # Public, read-only presale auto-seat suggestion (no writes).
    path(
        "smartseating/<str:organizer>/<str:event>/autoseat-suggest/",
        views_presale.api_suggest,
        name="presale.autoseat_suggest",
    ),
]
