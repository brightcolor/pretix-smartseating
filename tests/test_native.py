"""Tests for the native pretix seating bridge."""
import pytest
from django.core.exceptions import ValidationError
from django_scopes import scopes_disabled

from pretix_smartseating.models import SeatDefinition
from pretix_smartseating.services.native import (
    DEFAULT_CATEGORY_NAME,
    build_pretix_layout,
    sync_plan_to_event,
)


@pytest.mark.django_db
def test_build_layout_is_schema_valid(local_plan):
    layout = build_pretix_layout(local_plan)
    assert layout["name"] == "Hall A"
    assert layout["size"] == {"width": 1000, "height": 600}
    assert {c["name"] for c in layout["categories"]} == {"stalls"}
    guids = [s["seat_guid"] for z in layout["zones"] for r in z["rows"] for s in r["seats"]]
    assert len(guids) == 2 and len(set(guids)) == 2
    # build_pretix_layout already runs SeatingPlanLayoutValidator; reaching here means valid.


@pytest.mark.django_db
def test_build_layout_adds_default_category_for_uncategorized(local_plan):
    with scopes_disabled():
        SeatDefinition.objects.create(
            plan=local_plan, external_id="A-1-3", block_label="A", row_label="1",
            seat_number="3", seat_index=2, row_index=1, x=50, y=10, category=None,
        )
    layout = build_pretix_layout(local_plan)
    assert DEFAULT_CATEGORY_NAME in {c["name"] for c in layout["categories"]}
    cats_used = {s["category"] for z in layout["zones"] for r in z["rows"] for s in r["seats"]}
    assert DEFAULT_CATEGORY_NAME in cats_used


@pytest.mark.django_db
def test_hidden_seats_are_excluded(local_plan):
    with scopes_disabled():
        SeatDefinition.objects.create(
            plan=local_plan, external_id="hidden", block_label="A", row_label="1",
            seat_number="9", seat_index=8, row_index=1, x=99, y=10, is_hidden=True,
        )
    layout = build_pretix_layout(local_plan)
    guids = [s["seat_guid"] for z in layout["zones"] for r in z["rows"] for s in r["seats"]]
    assert len(guids) == 2  # hidden seat not emitted


@pytest.mark.django_db
def test_sync_generates_native_seats_and_mapping(event, item, local_plan):
    from pretix.base.models import Seat
    from pretix.base.models.seating import SeatCategoryMapping

    result = sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})

    assert result.seat_count == 2
    assert result.mapped_categories == ["stalls"]
    with scopes_disabled():
        local_plan.refresh_from_db()
        event.refresh_from_db()
        assert local_plan.pretix_plan_id is not None
        assert event.seating_plan_id == local_plan.pretix_plan_id
        seats = list(Seat.objects.filter(event=event))
        assert len(seats) == 2
        assert all(s.product_id == item.pk for s in seats)
        assert SeatCategoryMapping.objects.filter(event=event, layout_category="stalls").count() == 1


@pytest.mark.django_db
def test_sync_marks_blocked_seats(event, item, local_plan):
    from pretix.base.models import Seat
    with scopes_disabled():
        s = local_plan.seats.get(external_id="A-1-2")
        s.is_blocked = True
        s.save()
    result = sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    assert result.blocked_count == 1
    with scopes_disabled():
        blocked = Seat.objects.filter(event=event, blocked=True)
        assert blocked.count() == 1
        assert str(blocked.first().seat_guid) == str(local_plan.seats.get(external_id="A-1-2").guid)


@pytest.mark.django_db
def test_sync_is_idempotent(event, item, local_plan):
    from pretix.base.models import Seat
    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        first_plan_id = (local_plan.__class__.objects.get(pk=local_plan.pk)).pretix_plan_id
    # Re-apply: should reuse the same pretix plan and not duplicate seats.
    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        local_plan.refresh_from_db()
        assert local_plan.pretix_plan_id == first_plan_id
        assert Seat.objects.filter(event=event).count() == 2


@pytest.mark.django_db
def test_sync_unmapped_category_leaves_seats_unsold(event, local_plan):
    from pretix.base.models import Seat
    result = sync_plan_to_event(event=event, plan=local_plan, product_map={})
    assert result.unmapped_categories == ["stalls"]
    with scopes_disabled():
        seats = Seat.objects.filter(event=event)
        assert seats.count() == 2
        assert all(s.product_id is None for s in seats)


@pytest.mark.django_db
def test_build_layout_rejects_duplicate_seat_guids(local_plan, monkeypatch):
    # Force two seats to share a guid -> pretix validator must reject.
    seats = list(local_plan.seats.all())
    shared = seats[0].guid
    monkeypatch.setattr(
        "pretix_smartseating.services.native._seat_guid",
        lambda seat: str(shared),
    )
    with pytest.raises(ValidationError):
        build_pretix_layout(local_plan)
