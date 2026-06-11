from django import forms
from django.utils.translation import gettext_lazy as _

from pretix_smartseating.models import SeatingPlan


class SeatingPlanForm(forms.ModelForm):
    class Meta:
        model = SeatingPlan
        fields = ["name", "slug", "description", "width", "height", "grid_size", "snap_enabled"]


class ImportPlanForm(forms.Form):
    payload = forms.JSONField(label=_("JSON payload"), required=False)
    svg_file = forms.FileField(
        label=_("SVG floor plan"), required=False,
        help_text=_("Alternative to JSON: every <circle>/<ellipse>/<rect> whose id starts "
                    "with the prefix becomes a seat (e.g. id=\"seat-A12\" → row A, seat 12)."),
    )
    svg_prefix = forms.CharField(label=_("SVG seat id prefix"), required=False, initial="seat-")
    replace_existing = forms.BooleanField(label=_("Replace existing seats"), required=False, initial=True)

    def clean(self):
        data = super().clean()
        if not data.get("payload") and not data.get("svg_file"):
            raise forms.ValidationError(_("Provide either a JSON payload or an SVG file."))
        return data
