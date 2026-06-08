from datetime import timezone as dt_timezone

import pytest
from django.utils import timezone
from django_scopes import scopes_disabled


@pytest.fixture
def organizer(db):
    from pretix.base.models import Organizer
    with scopes_disabled():
        return Organizer.objects.create(name="Demo Org", slug="demo")


@pytest.fixture
def event(organizer):
    from pretix.base.models import Event
    with scopes_disabled():
        return Event.objects.create(
            organizer=organizer,
            name="Demo Event",
            slug="demo-event",
            date_from=timezone.datetime(2030, 1, 1, 20, 0, tzinfo=dt_timezone.utc),
            currency="EUR",
            live=True,
            plugins="pretix_smartseating",
        )


@pytest.fixture
def item(event):
    from pretix.base.models import Item
    with scopes_disabled():
        return Item.objects.create(event=event, name="Ticket", default_price=23, active=True)


@pytest.fixture
def local_plan(organizer):
    """A minimal smartseating editor plan with one category and two seats."""
    from pretix_smartseating.models import SeatCategory, SeatDefinition, SeatingPlan
    with scopes_disabled():
        plan = SeatingPlan.objects.create(
            scope_organizer=organizer, name="Hall A", slug="hall-a", width=1000, height=600
        )
        cat = SeatCategory.objects.create(plan=plan, name="Stalls", code="stalls", color="#3B82F6")
        SeatDefinition.objects.create(
            plan=plan, external_id="A-1-1", block_label="A", row_label="1", seat_number="1",
            seat_index=0, row_index=1, x=10, y=10, category=cat,
        )
        SeatDefinition.objects.create(
            plan=plan, external_id="A-1-2", block_label="A", row_label="1", seat_number="2",
            seat_index=1, row_index=1, x=30, y=10, category=cat,
        )
        return plan
