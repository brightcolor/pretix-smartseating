from django import forms
from django.utils.translation import gettext_lazy as _

from pretix_smartseating.models import SeatCategory, SeatingPlan


class SeatingPlanForm(forms.ModelForm):
    class Meta:
        model = SeatingPlan
        fields = ["name", "slug", "description", "width", "height", "grid_size", "snap_enabled"]


class ImportPlanForm(forms.Form):
    payload = forms.JSONField(label=_("JSON payload"))
    replace_existing = forms.BooleanField(label=_("Replace existing seats"), required=False, initial=True)


class AutoSeatForm(forms.Form):
    MODE_CHOICES = [
        ("strict_adjacent", _("Strict adjacent")),
        ("nearby_row_flexible", _("Nearby row flexible")),
        ("best_available", _("Best available")),
    ]
    quantity = forms.IntegerField(min_value=1, max_value=20, initial=2)
    mode = forms.ChoiceField(choices=MODE_CHOICES)
    category = forms.ModelChoiceField(queryset=SeatCategory.objects.none(), required=False)
    require_accessible = forms.BooleanField(required=False)
    prefer_center = forms.BooleanField(required=False, initial=True)
    prefer_front = forms.BooleanField(required=False)

    def __init__(self, *args, **kwargs):
        plan = kwargs.pop("plan", None)
        super().__init__(*args, **kwargs)
        if plan:
            self.fields["category"].queryset = plan.seat_categories.all()

