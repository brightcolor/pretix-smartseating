from django.utils.translation import gettext_lazy as _

from . import __version__

try:
    from pretix.base.plugins import PLUGIN_LEVEL_EVENT, PluginConfig
except ImportError:
    raise RuntimeError("Please use pretix 2025.10 or above to run this plugin!")


class PluginApp(PluginConfig):
    # PluginConfig's metaclass forces ``default = False``; we must opt in
    # explicitly so Django selects this AppConfig for the package.
    default = True
    name = "pretix_smartseating"
    verbose_name = "pretix Smart Seating"

    class PretixPluginMeta:
        name = _("Smart Seating")
        author = "Smart Seating Contributors"
        version = __version__
        category = "FEATURE"
        visible = True
        description = _(
            "Reserved seating with a visual editor, seat holds, auto-seat "
            "allocation and native pretix checkout integration."
        )
        # Seating plans live at organizer level but the plugin is enabled and
        # mapped per event, so the event level is the correct activation scope.
        level = PLUGIN_LEVEL_EVENT
        compatibility = "pretix>=2025.10"
        settings_links = []
        navigation_links = []

    def ready(self):
        from . import signals  # noqa: F401
