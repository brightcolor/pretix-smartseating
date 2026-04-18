from pretix_smartseating.services.validation import validate_layout_payload


def test_duplicate_external_id_detected_by_validation():
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
            },
            {
                "external_id": "A-A-1",
                "block_label": "A",
                "row_label": "A",
                "seat_number": "2",
                "category_code": "standard",
                "x": 120,
                "y": 100,
            },
        ],
    }
    issues = validate_layout_payload(payload)
    assert any(issue.code == "duplicate_external_id" for issue in issues)
