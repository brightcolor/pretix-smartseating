from types import SimpleNamespace

from pretix_smartseating.services.autoseat import AutoSeatOptions, find_seats


def _seat(row_index: int, seat_index: int, *, block: str = "A", category_id: int = 1):
    return SimpleNamespace(
        block_label=block,
        row_label=chr(65 + row_index),
        row_index=row_index,
        seat_index=seat_index,
        seat_number=str(seat_index + 1),
        x=float(seat_index),
        y=float(row_index),
        category_id=category_id,
        is_hidden=False,
        is_blocked=False,
        is_technical_blocked=False,
    )


def test_find_strict_adjacent_group():
    seats = [_seat(0, i) for i in range(10)]
    candidate = find_seats(seats, AutoSeatOptions(quantity=4, mode="strict_adjacent"))
    assert candidate is not None
    assert len(candidate.seats) == 4
    assert len({seat.row_label for seat in candidate.seats}) == 1


def test_find_nearby_row_flexible_uses_neighbor_row_when_needed():
    seats = [_seat(0, i) for i in range(2)] + [_seat(1, i) for i in range(2)]
    candidate = find_seats(seats, AutoSeatOptions(quantity=3, mode="nearby_row_flexible"))
    assert candidate is not None
    assert candidate.reason in {"nearby_row_flexible", "strict_adjacent"}


def test_find_best_available_returns_none_when_not_enough_seats():
    seats = [_seat(0, 0)]
    candidate = find_seats(seats, AutoSeatOptions(quantity=2, mode="best_available"))
    assert candidate is None
