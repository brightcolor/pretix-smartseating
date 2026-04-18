from types import SimpleNamespace

from pretix_smartseating.services.autoseat import AutoSeatOptions, find_seats


def _seat(row_index: int, seat_index: int):
    return SimpleNamespace(
        block_label="A",
        row_label=chr(65 + row_index),
        row_index=row_index,
        seat_index=seat_index,
        seat_number=str(seat_index + 1),
        x=float(seat_index),
        y=float(row_index),
        category=SimpleNamespace(code="standard"),
        category_id=1,
        is_hidden=False,
        is_blocked=False,
        is_technical_blocked=False,
        is_accessible=row_index == 0,
    )


def test_autoseat_category_filter():
    seats = [_seat(0, 0), _seat(0, 1)]
    seats[1].category = SimpleNamespace(code="vip")
    candidate = find_seats(
        seats,
        AutoSeatOptions(quantity=1, mode="best_available", category_code="vip"),
    )
    assert candidate is not None
    assert candidate.seats[0].category.code == "vip"


def test_autoseat_accessible_filter():
    seats = [_seat(0, 0), _seat(1, 0)]
    seats[1].is_accessible = False
    candidate = find_seats(
        seats,
        AutoSeatOptions(quantity=1, mode="best_available", require_accessible=True),
    )
    assert candidate is not None
    assert candidate.seats[0].is_accessible is True

