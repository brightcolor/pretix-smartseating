from django import forms
from django.utils.translation import gettext_lazy as _

from pretix_smartseating.models import SeatingPlan


class SeatingPlanForm(forms.ModelForm):
    class Meta:
        model = SeatingPlan
        fields = ["name", "slug", "description", "width", "height", "grid_size", "snap_enabled"]


class ImportPlanForm(forms.Form):
    payload = forms.JSONField(label=_("JSON-Datei"), required=False)
    svg_file = forms.FileField(
        label=_("SVG-Grundriss"), required=False,
        help_text=_("Alternative zu JSON: Jedes <circle>/<ellipse>/<rect>, dessen id mit dem Präfix beginnt, "
                    "wird zum Sitz (z.B. id=\"seat-A12\" → Reihe A, Platz 12)."),
    )
    svg_prefix = forms.CharField(label=_("SVG-Sitz-ID-Präfix"), required=False, initial="seat-")
    replace_existing = forms.BooleanField(label=_("Vorhandene Sitze ersetzen"), required=False, initial=True)

    def clean(self):
        data = super().clean()
        if not data.get("payload") and not data.get("svg_file"):
            raise forms.ValidationError(_("Bitte eine JSON-Datei oder eine SVG-Datei angeben."))
        return data
