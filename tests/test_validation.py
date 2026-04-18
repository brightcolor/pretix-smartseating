from pretix_smartseating.services.validation import validate_layout_payload


def test_validation_detects_duplicates_and_invalid_category():
    payload = {
        "bounds": {"width": 100, "height": 100},
        "categories": [{"code": "standard"}],
        "seats": [
            {
                "external_id": "A-1",
                "block_label": "A",
                "row_label": "A",
                "seat_number": "1",
                "category_code": "standard",
                "x": 10,
                "y": 10,
            },
            {
                "external_id": "A-1",
                "block_label": "A",
                "row_label": "A",
                "seat_number": "1",
                "category_code": "invalid",
                "x": 150,
                "y": 10,
            },
        ],
    }
    issues = validate_layout_payload(payload)
    codes = {issue.code for issue in issues}
    assert "duplicate_external_id" in codes
    assert "duplicate_visible_seat" in codes
    assert "invalid_category" in codes
    assert "seat_out_of_bounds" in codes

