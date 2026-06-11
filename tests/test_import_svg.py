import pytest

from pretix_smartseating.services.import_export import seats_from_svg

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <g>
    <circle id="seat-A1" cx="100" cy="50" r="6"/>
    <circle id="seat-A2" cx="130" cy="50" r="6"/>
    <rect id="seat-B1" x="94" y="94" width="12" height="12"/>
    <ellipse id="seat-7" cx="200" cy="50" rx="6" ry="5"/>
    <circle id="decoration" cx="1" cy="1" r="1"/>
  </g>
</svg>"""


def test_seats_from_svg_parses_elements():
    payload = seats_from_svg(SVG)
    assert payload["plan"] == {"width": 800, "height": 600}
    seats = {s["external_id"]: s for s in payload["seats"]}
    assert set(seats) == {"seat-A1", "seat-A2", "seat-B1", "seat-7"}
    # id convention: letters → row, digits → number
    assert seats["seat-A1"]["row_label"] == "A"
    assert seats["seat-A1"]["seat_number"] == "1"
    # rect centre
    assert seats["seat-B1"]["x"] == 100 and seats["seat-B1"]["y"] == 100
    # bare number falls back to row "S"
    assert seats["seat-7"]["row_label"] == "S"
    assert seats["seat-7"]["seat_number"] == "7"


def test_seats_from_svg_custom_prefix():
    payload = seats_from_svg(SVG.replace("seat-", "platz_"), prefix="platz_")
    assert len(payload["seats"]) == 4


def test_seats_from_svg_rejects_svg_without_seats():
    with pytest.raises(ValueError):
        seats_from_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')
