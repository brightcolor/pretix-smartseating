from django.apps import AppConfig
from django.utils.translation import gettext_lazy as _


class PluginApp(AppConfig):
    name = "pretix_smartseating"
    verbose_name = "pretix Smart Seating"

    class PretixPluginMeta:
        name = _("Smart Seating")
        author = "Smart Seating Contributors"
        version = "0.1.2"
        visible = True
        category = "FEATURE"
        description = _("Reserved seating with visual editor, seat holds and auto-seat allocation.")
        compatibility = "pretix>=2025.1"
        urlconf = "pretix_smartseating.urls"

    def ready(self):
        from . import signals  # noqa: F401
