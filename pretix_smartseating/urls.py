from django.urls import path

from pretix_smartseating import views_api, views_control

app_name = "pretix_smartseating"

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
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/import/",
        views_control.plan_import,
        name="control.plan_import",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/smartseating/<int:plan_id>/export/",
        views_control.plan_export,
        name="control.plan_export",
    ),
    path("api/v1/<str:organizer>/<str:event>/seatplan/", views_api.api_plan, name="api.plan"),
    path(
        "api/v1/<str:organizer>/<str:event>/availability/",
        views_api.api_availability,
        name="api.availability",
    ),
    path("api/v1/<str:organizer>/<str:event>/hold/", views_api.api_hold, name="api.hold"),
    path(
        "api/v1/<str:organizer>/<str:event>/release-hold/",
        views_api.api_release_hold,
        name="api.release_hold",
    ),
    path("api/v1/<str:organizer>/<str:event>/autoseat/", views_api.api_autoseat, name="api.autoseat"),
    path(
        "api/v1/<str:organizer>/<str:event>/confirm-sale/",
        views_api.api_confirm_sale,
        name="api.confirm_sale",
    ),
]

