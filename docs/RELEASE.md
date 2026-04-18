# Release Process

## Versioning

- SemVer: `MAJOR.MINOR.PATCH`
- Initial release: `0.1.0`

## Schritte

1. `pytest`, `ruff`, `mypy` erfolgreich
2. `CHANGELOG.md` aktualisieren
3. Version in `pyproject.toml` und `pretix_smartseating/apps.py` erhöhen
4. Tag erstellen: `git tag vX.Y.Z`
5. Package builden: `python -m build`
6. Veröffentlichung (PyPI/GitHub Release)

