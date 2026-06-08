"""Security-focused tests: upload hardening and control-view permissions."""
import io

import pytest
from django_scopes import scopes_disabled

from pretix_smartseating.views_control import _sanitize_svg, _svg_dimensions, _verify_raster

CLEAN_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="10" height="10"/></svg>'
SCRIPT_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">'
    b'<script>alert(1)</script>'
    b'<rect width="5" height="5" onload="evil()" fill="url(javascript:alert(2))"/>'
    b'</svg>'
)
BILLION_LAUGHS = (
    b'<?xml version="1.0"?>'
    b'<!DOCTYPE lolz [<!ENTITY lol "lol">'
    b'<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>'
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&lol2;</text></svg>'
)


def test_sanitize_svg_strips_script_and_handlers():
    sanitized, (w, h) = _sanitize_svg(SCRIPT_SVG)
    assert b"<script" not in sanitized.lower() if isinstance(sanitized, bytes) else True
    text = sanitized.decode("utf-8").lower()
    assert "script" not in text
    assert "onload" not in text
    assert "javascript:" not in text
    assert (w, h) == (100, 50)


def test_sanitize_svg_rejects_entity_expansion():
    with pytest.raises(ValueError):
        _sanitize_svg(BILLION_LAUGHS)


def test_sanitize_svg_passes_clean_file():
    sanitized, (w, h) = _sanitize_svg(CLEAN_SVG)
    assert b"rect" in sanitized
    assert (w, h) == (120, 80)


def test_svg_dimensions_from_viewbox():
    from defusedxml import ElementTree as SafeET
    root = SafeET.fromstring(
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>'
    )
    assert _svg_dimensions(root) == (640, 480)


def test_verify_raster_rejects_non_image():
    with pytest.raises(ValueError):
        _verify_raster(b"this is definitely not an image")


def test_verify_raster_accepts_real_png():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (24, 16), "white").save(buf, format="PNG")
    assert _verify_raster(buf.getvalue()) == (24, 16)


# --- control-view permission enforcement -------------------------------------

@pytest.fixture
def user(db):
    from pretix.base.models import User
    return User.objects.create_user("staff@example.com", "dummy")


def _login(client, user):
    client.force_login(user)


@pytest.mark.django_db
def test_plan_list_denied_without_permission(client, event, user):
    # User has no team/permission on the event -> control middleware returns 404.
    _login(client, user)
    url = f"/control/event/{event.organizer.slug}/{event.slug}/smartseating/"
    resp = client.get(url)
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_plan_list_allowed_with_permission(client, event, user):
    from pretix.base.models import Team
    with scopes_disabled():
        team = Team.objects.create(
            organizer=event.organizer, all_event_permissions=True, all_events=True
        )
        team.members.add(user)
    _login(client, user)
    url = f"/control/event/{event.organizer.slug}/{event.slug}/smartseating/"
    resp = client.get(url)
    assert resp.status_code == 200
