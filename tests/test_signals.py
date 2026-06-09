"""Tests for the presale render_seating_plan receiver (shop seat map)."""
import pytest
from django_scopes import scopes_disabled

from pretix_smartseating.models import EventSeatPlanMapping
from pretix_smartseating.signals import shop_render_seating_plan


@pytest.mark.django_db
def test_render_seating_plan_empty_without_mapping(event):
    assert shop_render_seating_plan(sender=event, request=None) == ""


@pytest.mark.django_db
def test_render_seating_plan_injects_when_mapped(event, local_plan):
    with scopes_disabled():
        EventSeatPlanMapping.objects.create(event=event, subevent=None, plan=local_plan)
    html = shop_render_seating_plan(sender=event, request=None)
    assert "shop_seatmap.js" in html
    assert 'id="smartseat-shop"' in html
    assert "data-seatmap-url" in html
    assert "/seatmap/" in html
