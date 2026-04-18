from pretix_smartseating.services.validation import validate_layout_payload


def test_layout_payload_accepts_valid_minimal_payload():
    payload = {
        "bounds": {"width": 500, "height": 300},
        "categories": [{"code": "standard"}],
        "seats": [
            {
                "external_id": "A-A-1",
                "block_label": "A",
                "row_label": "A",
                "seat_number": "1",
                "category_code": "standard",
                "x": 100,
                "y": 100,
            }
        ],
    }
    issues = validate_layout_payload(payload)
    assert issues == []


def test_layout_payload_rejects_unknown_category():
    payload = {
        "bounds": {"width": 500, "height": 300},
        "categories": [{"code": "standard"}],
        "seats": [
            {
                "external_id": "A-A-1",
                "block_label": "A",
                "row_label": "A",
                "seat_number": "1",
                "category_code": "vip",
                "x": 100,
                "y": 100,
            }
        ],
    }
    issues = validate_layout_payload(payload)
    assert any(issue.code == "invalid_category" for issue in issues)

