"""Tests for the presale seating-frame head injection."""
import pytest
from django_scopes import scopes_disabled

from pretix_smartseating.models import EventSeatPlanMapping
from pretix_smartseating.signals import inject_autoseat_helper


@pytest.mark.django_db
def test_seatingframe_head_empty_without_mapping(event):
    assert inject_autoseat_helper(sender=event, request=None) == ""


@pytest.mark.django_db
def test_seatingframe_head_injects_when_mapped(event, local_plan):
    with scopes_disabled():
        EventSeatPlanMapping.objects.create(event=event, subevent=None, plan=local_plan)
    html = inject_autoseat_helper(sender=event, request=None)
    assert "shop_autoseat.js" in html
    assert "smartseating-shop-config" in html
    assert "autoseat-suggest" in html
    # The JSON config must not be able to break out of the <script> element.
    assert "</script" not in html.split("application/json", 1)[1].split("</script>", 1)[0].lower()
