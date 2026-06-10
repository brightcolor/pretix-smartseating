"""Tests for the native pretix seating bridge."""
from datetime import timedelta

import pytest
from django.core.exceptions import ValidationError
from django.utils import timezone
from django_scopes import scopes_disabled

from pretix_smartseating.models import EventSeatPlanMapping, SeatDefinition
from pretix_smartseating.services.native import (
    DEFAULT_CATEGORY_NAME,
    build_pretix_layout,
    layout_from_pretix,
    suggest_seats,
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
def test_native_seat_available_then_held_by_cart(event, item, local_plan):
    """End-to-end: generated seats use pretix' native availability + hold logic.

    A cart position holds the seat against everyone else (parallel double
    booking prevented) but not against its own cart, and an expired cart
    releases it — exactly the contract pretix' checkout relies on.
    """
    from pretix.base.models import CartPosition, Seat

    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        seat = Seat.objects.filter(event=event, blocked=False).first()
        assert seat.is_available() is True

        cart = CartPosition.objects.create(
            event=event,
            cart_id="cart-A",
            item=item,
            price=item.default_price,
            expires=timezone.now() + timedelta(minutes=10),
            seat=seat,
            subevent=None,
        )
        # Held for everyone else, but the holding cart may still use it.
        assert seat.is_available() is False
        assert seat.is_available(ignore_cart=cart) is True

        # Expired hold frees the seat again.
        cart.expires = timezone.now() - timedelta(minutes=1)
        cart.save()
        assert seat.is_available() is True


@pytest.mark.django_db
def test_native_blocked_seat_not_available(event, item, local_plan):
    from pretix.base.models import Seat

    with scopes_disabled():
        s = local_plan.seats.get(external_id="A-1-2")
        s.is_blocked = True
        s.save()
    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        blocked = Seat.objects.get(event=event, blocked=True)
        # Default settings allow blocked seats for no sales channel.
        assert blocked.is_available() is False


@pytest.mark.django_db
def test_suggest_seats_returns_available_group(event, item, local_plan):
    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    suggestions = suggest_seats(event=event, plan=local_plan, quantity=2, mode="strict_adjacent")
    assert len(suggestions) == 2
    guids = {s.seat_guid for s in suggestions}
    with scopes_disabled():
        expected = {str(g) for g in local_plan.seats.values_list("guid", flat=True)}
    assert guids <= expected
    assert all(s.label for s in suggestions)


@pytest.mark.django_db
def test_suggest_seats_skips_held_seat(event, item, local_plan):
    from pretix.base.models import CartPosition, Seat

    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        # Hold one of the two seats via a cart -> only one seat remains free,
        # so a request for 2 adjacent seats can no longer be satisfied.
        seat = Seat.objects.filter(event=event).first()
        CartPosition.objects.create(
            event=event, cart_id="c1", item=item, price=item.default_price,
            expires=timezone.now() + timedelta(minutes=10), seat=seat, subevent=None,
        )
    assert suggest_seats(event=event, plan=local_plan, quantity=2, mode="strict_adjacent") == []
    # A single seat is still suggestible.
    assert len(suggest_seats(event=event, plan=local_plan, quantity=1, mode="best_available")) == 1


@pytest.mark.django_db
def test_suggest_endpoint_read_only(client, event, item, local_plan):
    sync_plan_to_event(event=event, plan=local_plan, product_map={"stalls": item})
    with scopes_disabled():
        EventSeatPlanMapping.objects.get_or_create(event=event, subevent=None, defaults={"plan": local_plan})
    url = f"/smartseating/{event.organizer.slug}/{event.slug}/autoseat-suggest/?quantity=2&mode=strict_adjacent"
    resp = client.get(url)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["count"] == 2
    assert len(data["seats"]) == 2
    # POST must not be allowed (read-only endpoint).
    assert client.post(url).status_code == 405


@pytest.mark.django_db
def test_suggest_endpoint_rejects_bad_quantity(client, event):
    url = f"/smartseating/{event.organizer.slug}/{event.slug}/autoseat-suggest/?quantity=999"
    resp = client.get(url)
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_quantity"


@pytest.mark.django_db
def test_build_layout_includes_areas(local_plan):
    with scopes_disabled():
        local_plan.area_shapes = [
            {"shape": "rectangle", "position": {"x": 0, "y": 0},
             "rectangle": {"width": 100, "height": 20}, "color": "#000000"},
        ]
        local_plan.save()
    layout = build_pretix_layout(local_plan)
    decor = [z for z in layout["zones"] if z.get("areas")]
    assert decor and decor[0]["areas"][0]["shape"] == "rectangle"


@pytest.mark.django_db
def test_build_layout_strips_editor_only_role(local_plan):
    """Polygon areas may carry an editor-only ``role`` flag (interactive vs
    decoration); it must be stripped before native validation."""
    with scopes_disabled():
        local_plan.area_shapes = [
            {"shape": "polygon", "role": "product", "product": 42, "product_name": "Standing",
             "position": {"x": 0, "y": 0},
             "polygon": {"points": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 25, "y": 40}]},
             "color": "#000000"},
        ]
        local_plan.save()
    layout = build_pretix_layout(local_plan)  # must not raise on the extra keys
    area = [z for z in layout["zones"] if z.get("areas")][0]["areas"][0]
    assert "role" not in area and "product" not in area and "product_name" not in area
    assert area["shape"] == "polygon"


def test_layout_from_pretix_roundtrip():
    pretix_layout = {
        "name": "Imported Hall",
        "size": {"width": 800, "height": 400},
        "categories": [{"name": "stalls", "color": "#ff0000"}],
        "zones": [{
            "name": "Block A",
            "position": {"x": 50, "y": 10},
            "areas": [{"shape": "text", "position": {"x": 0, "y": 0},
                       "text": {"text": "Stage", "position": {"x": 0, "y": 0}}}],
            "rows": [{
                "row_number": "1", "row_label": "Row 1", "position": {"x": 5, "y": 0},
                "seats": [
                    {"seat_guid": "g1", "seat_number": "1", "category": "stalls",
                     "position": {"x": 0, "y": 0}},
                    {"seat_guid": "g2", "seat_number": "2", "category": "stalls",
                     "position": {"x": 30, "y": 0}},
                ],
            }],
        }],
    }
    payload = layout_from_pretix(pretix_layout)
    assert payload["plan"]["width"] == 800
    assert {c["code"] for c in payload["categories"]} == {"stalls"}
    assert len(payload["seats"]) == 2
    s1 = next(s for s in payload["seats"] if s["external_id"] == "g1")
    # absolute x = zone(50) + row(5) + seat(0)
    assert s1["x"] == 55 and s1["block_label"] == "Block A"
    assert payload["areas"][0]["shape"] == "text"


def test_layout_from_pretix_rejects_invalid():
    with pytest.raises(Exception):
        layout_from_pretix({"not": "a valid layout"})


@pytest.mark.django_db
def test_areas_import_export_roundtrip(local_plan):
    from pretix_smartseating.services.import_export import export_plan, import_plan

    areas = [
        {"shape": "rectangle", "position": {"x": 10, "y": 5}, "rectangle": {"width": 200, "height": 40},
         "color": "#222222"},
        {"shape": "text", "position": {"x": 100, "y": 0}, "text": {"text": "Stage", "position": {"x": 0, "y": 0}}},
    ]
    payload = {
        "plan": {"width": 1000, "height": 600},
        "categories": [{"code": "stalls", "name": "Stalls"}],
        "areas": areas,
        "seats": [{
            "external_id": "A-1-1", "block_label": "A", "row_label": "1", "seat_number": "1",
            "category_code": "stalls", "x": 10, "y": 10,
        }],
        "bounds": {"width": 1000, "height": 600},
    }
    with scopes_disabled():
        issues = import_plan(local_plan, payload, replace_existing=True)
        assert issues == []
        local_plan.refresh_from_db()
        assert local_plan.area_shapes == areas
        bundle = export_plan(local_plan)
        assert bundle.areas == areas


@pytest.mark.django_db
def test_import_allows_duplicate_visible_labels_with_unique_guids(local_plan):
    """Real seats.pretix.eu plans repeat (zone/row/seat) labels across row
    segments; only the seat GUID is unique. Import must not be blocked."""
    from pretix_smartseating.services.import_export import import_plan

    payload = {
        "plan": {"width": 1000, "height": 600},
        "categories": [{"code": "stalls", "name": "Stalls"}],
        "seats": [
            {"external_id": "guid-a", "block_label": "Ground floor", "row_label": "1",
             "seat_number": "1", "category_code": "stalls", "x": 10, "y": 10},
            {"external_id": "guid-b", "block_label": "Ground floor", "row_label": "1",
             "seat_number": "1", "category_code": "stalls", "x": 200, "y": 10},
        ],
        "bounds": {"width": 1000, "height": 600},
    }
    with scopes_disabled():
        issues = import_plan(local_plan, payload, replace_existing=True)
        assert issues == []  # duplicate visible label is non-blocking
        assert local_plan.seats.count() == 2


@pytest.mark.django_db
def test_zones_persisted_and_derived(local_plan):
    from pretix_smartseating.services.import_export import export_plan, import_plan

    payload = {
        "plan": {"width": 1000, "height": 600},
        "categories": [{"code": "stalls", "name": "Stalls"}],
        "zones": [{"name": "Balcony"}],  # explicit empty zone persists
        "seats": [
            {"external_id": "s1", "block_label": "Ground floor", "row_label": "1",
             "seat_number": "1", "category_code": "stalls", "x": 10, "y": 10},
        ],
        "bounds": {"width": 1000, "height": 600},
    }
    with scopes_disabled():
        assert import_plan(local_plan, payload, replace_existing=True) == []
        local_plan.refresh_from_db()
        names = {z["name"] for z in export_plan(local_plan).zones}
        # explicit zone + the zone derived from a seat's block_label
        assert "Balcony" in names and "Ground floor" in names


def test_layout_from_pretix_extracts_zones():
    layout = {
        "name": "Hall", "size": {"width": 800, "height": 400},
        "categories": [{"name": "a"}],
        "zones": [
            {"name": "Ground floor", "position": {"x": 0, "y": 0}, "rows": [
                {"row_number": "1", "position": {"x": 0, "y": 0}, "seats": [
                    {"seat_guid": "g1", "seat_number": "1", "category": "a", "position": {"x": 0, "y": 0}}]}]},
            {"name": "VIP", "position": {"x": 0, "y": 200}, "rows": []},
        ],
    }
    payload = layout_from_pretix(layout)
    assert [z["name"] for z in payload["zones"]] == ["Ground floor", "VIP"]


@pytest.mark.django_db
def test_groups_import_export_roundtrip(local_plan):
    from pretix_smartseating.services.import_export import export_plan, import_plan

    groups = [
        {"id": "g1", "name": "Left block", "seat_ids": ["A-1-1"], "parent": None},
        {"id": "g2", "name": "All", "seat_ids": ["A-1-2"], "parent": None},
    ]
    payload = {
        "plan": {"width": 1000, "height": 600},
        "categories": [{"code": "stalls", "name": "Stalls"}],
        "groups": groups,
        "seats": [
            {"external_id": "A-1-1", "block_label": "A", "row_label": "1", "seat_number": "1",
             "category_code": "stalls", "x": 10, "y": 10},
            {"external_id": "A-1-2", "block_label": "A", "row_label": "1", "seat_number": "2",
             "category_code": "stalls", "x": 30, "y": 10},
        ],
        "bounds": {"width": 1000, "height": 600},
    }
    with scopes_disabled():
        assert import_plan(local_plan, payload, replace_existing=True) == []
        local_plan.refresh_from_db()
        assert local_plan.seat_groups == groups
        assert export_plan(local_plan).groups == groups


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
