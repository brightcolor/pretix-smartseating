import json

from django.dispatch import receiver
from django.templatetags.static import static
from django.urls import reverse
from django.utils.safestring import mark_safe
from django.utils.translation import gettext_lazy as _
from pretix.control.signals import nav_event
from pretix.presale.signals import seatingframe_html_head

from pretix_smartseating.models import EventSeatPlanMapping


@receiver(nav_event, dispatch_uid="pretix_smartseating_nav_event")
def control_nav_entries(sender, request, **kwargs):
    event = sender
    url = reverse(
        "plugins:pretix_smartseating:control.plan_list",
        kwargs={"organizer": event.organizer.slug, "event": event.slug},
    )
    return [
        {
            "label": _("Smart Seating"),
            "icon": "th",
            "url": url,
            "active": request.path.startswith(url),
        }
    ]


@receiver(seatingframe_html_head, dispatch_uid="pretix_smartseating_seatingframe_head")
def inject_autoseat_helper(sender, request=None, **kwargs):
    """Inject the read-only auto-seat helper into the native seating page.

    Only fires when this event has a smartseating plan mapped. The helper
    fetches seat suggestions from our read-only endpoint and surfaces the
    recommended seats; the actual booking is done by the customer in pretix'
    own seating widget.
    """
    event = sender
    if not EventSeatPlanMapping.objects.filter(event=event).exists():
        return ""

    config = {
        "suggestUrl": reverse(
            "plugins:pretix_smartseating:presale.autoseat_suggest",
            kwargs={"organizer": event.organizer.slug, "event": event.slug},
        ),
    }
    # Escape "<" so the JSON cannot terminate the <script> element early.
    config_json = json.dumps(config).replace("<", "\\u003c")
    css = static("pretix_smartseating/css/shop_autoseat.css")
    js = static("pretix_smartseating/js/shop_autoseat.js")
    return mark_safe(
        f'<link rel="stylesheet" href="{css}">'
        f'<script type="application/json" id="smartseating-shop-config">{config_json}</script>'
        f'<script defer src="{js}"></script>'
    )
