from django.dispatch import receiver
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from pretix.control.signals import nav_event


@receiver(nav_event, dispatch_uid="pretix_smartseating_nav_event")
def control_nav_entries(sender, request, **kwargs):
    event = sender
    return [
        {
            "label": _("Smart Seating"),
            "icon": "chair",
            "url": reverse(
                "plugins:pretix_smartseating:control.plan_list",
                kwargs={"organizer": event.organizer.slug, "event": event.slug},
            ),
            "active": request.path.startswith(
                reverse(
                    "plugins:pretix_smartseating:control.plan_list",
                    kwargs={"organizer": event.organizer.slug, "event": event.slug},
                )
            ),
        }
    ]

