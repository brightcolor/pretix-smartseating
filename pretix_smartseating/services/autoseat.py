from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from math import hypot
from typing import Any


@dataclass
class AutoSeatOptions:
    quantity: int
    mode: str = "strict_adjacent"
    category_code: str | None = None
    require_accessible: bool = False
    nearby_row_flexible: bool = False
    prefer_center: bool = True
    prefer_front: bool = False
    preferred_blocks: list[str] | None = None
    avoid_orphans: bool = True


@dataclass
class Candidate:
    seats: list[Any]
    score: float
    reason: str


def _contiguous_windows(row_seats: list[Any], quantity: int) -> list[list[Any]]:
    windows: list[list[Any]] = []
    if len(row_seats) < quantity:
        return windows
    for idx in range(len(row_seats) - quantity + 1):
        window = row_seats[idx : idx + quantity]
        contiguous = True
        for i in range(1, len(window)):
            if window[i].seat_index != window[i - 1].seat_index + 1:
                contiguous = False
                break
        if contiguous:
            windows.append(window)
    return windows


def _score_group(seats: list[Any], opts: AutoSeatOptions) -> float:
    center_x = sum(seat.x for seat in seats) / len(seats)
    center_y = sum(seat.y for seat in seats) / len(seats)
    spread = 0.0
    for seat_a, seat_b in combinations(seats, 2):
        spread += hypot(seat_a.x - seat_b.x, seat_a.y - seat_b.y)

    score = 1000.0
    if opts.prefer_center:
        score -= abs(center_x)
    if opts.prefer_front:
        score -= center_y * 0.3
    score -= spread * 0.2
    if len({seat.row_label for seat in seats}) == 1:
        score += 80
    adjacency_bonus = sum(
        1
        for seat_a, seat_b in combinations(seats, 2)
        if seat_a.row_label == seat_b.row_label and abs(seat_a.seat_index - seat_b.seat_index) == 1
    )
    score += adjacency_bonus * 12
    if opts.preferred_blocks:
        preferred = sum(1 for seat in seats if seat.block_label in opts.preferred_blocks)
        score += preferred * 8
    if len({seat.category_id for seat in seats}) == 1:
        score += 25
    return score


def _filter_candidates(seats: list[Any], opts: AutoSeatOptions) -> list[Any]:
    filtered = [seat for seat in seats if not seat.is_hidden and not seat.is_blocked and not seat.is_technical_blocked]
    if opts.category_code:
        filtered = [seat for seat in filtered if seat.category and seat.category.code == opts.category_code]
    if opts.require_accessible:
        filtered = [seat for seat in filtered if seat.is_accessible]
    return filtered


def find_seats(available_seats: list[Any], opts: AutoSeatOptions) -> Candidate | None:
    seats = _filter_candidates(available_seats, opts)
    if len(seats) < opts.quantity:
        return None

    grouped: dict[tuple[str, str], list[Any]] = {}
    for seat in sorted(seats, key=lambda s: (s.block_label, s.row_index, s.seat_index)):
        grouped.setdefault((seat.block_label, seat.row_label), []).append(seat)

    if opts.mode == "strict_adjacent":
        candidates: list[Candidate] = []
        for row_seats in grouped.values():
            for window in _contiguous_windows(row_seats, opts.quantity):
                candidates.append(Candidate(window, _score_group(window, opts), "strict_adjacent"))
        return max(candidates, key=lambda c: c.score) if candidates else None

    if opts.mode == "nearby_row_flexible":
        strict = find_seats(available_seats, AutoSeatOptions(**{**opts.__dict__, "mode": "strict_adjacent"}))
        if strict:
            return strict

        by_row_index: dict[int, list[Any]] = {}
        for seat in seats:
            by_row_index.setdefault(seat.row_index, []).append(seat)

        candidates = []
        for row_index, current_row in by_row_index.items():
            for neighbor in (row_index - 1, row_index + 1):
                if neighbor not in by_row_index:
                    continue
                pool = sorted(current_row + by_row_index[neighbor], key=lambda s: (s.row_index, s.seat_index))
                for combo in combinations(pool, opts.quantity):
                    if len({s.row_index for s in combo}) > 2:
                        continue
                    candidate = Candidate(list(combo), _score_group(list(combo), opts) - 40, "nearby_row_flexible")
                    candidates.append(candidate)
        return max(candidates, key=lambda c: c.score) if candidates else None

    candidates = []
    for row_seats in grouped.values():
        contiguous = _contiguous_windows(row_seats, min(opts.quantity, len(row_seats)))
        for window in contiguous:
            if len(window) == opts.quantity:
                candidates.append(Candidate(window, _score_group(window, opts), "best_available_row"))

    if not candidates:
        seats_sorted = sorted(seats, key=lambda s: (s.row_index, s.seat_index))
        for combo in combinations(seats_sorted[: min(80, len(seats_sorted))], opts.quantity):
            candidates.append(Candidate(list(combo), _score_group(list(combo), opts) - 20, "best_available_mix"))

    return max(candidates, key=lambda c: c.score) if candidates else None
