from django import forms
from django.utils.translation import gettext_lazy as _

from pretix_smartseating.models import SeatingPlan


class SeatingPlanForm(forms.ModelForm):
    class Meta:
        model = SeatingPlan
        fields = ["name", "slug", "description", "width", "height", "grid_size", "snap_enabled"]


class ImportPlanForm(forms.Form):
    payload = forms.JSONField(label=_("JSON payload"))
    replace_existing = forms.BooleanField(label=_("Replace existing seats"), required=False, initial=True)
