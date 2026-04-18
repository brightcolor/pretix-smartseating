# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-04-18

### Fixed
- Resolved `mypy` type-check issues in status-return paths and subevent parsing for CI stability

## [0.1.1] - 2026-04-18

### Added
- Theme integration guide for pretix shop template overrides (`docs/THEME-INTEGRATION.md`)
- Selector snippet now loads required shop styling directly

### Changed
- API input hardening with strict payload validation, mode/quantity bounds checks and structured error responses
- `confirm-sale` endpoint now requires authenticated staff context
- Auto-seat typing decoupled from Django model imports to keep lint/test tooling robust in isolated environments

## [0.1.0] - 2026-04-18

### Added
- Initial pretix plugin scaffolding and package metadata
- Data model for seat plans, versions, seats, categories, event mappings, states, holds and audit log
- JSON import/export service with validation
- Auto-seat service with `strict_adjacent`, `nearby_row_flexible` and `best_available`
- Hold/lock service with expiry handling and conflict-safe updates
- Control panel views and editor template
- Shop seat selector template and JavaScript frontend
- API endpoints for plan retrieval, availability, hold/release, auto-seat and sale confirmation
- Test suite for validation, auto-seat behavior, import/export and API conflict behavior
- Documentation set (`README`, install/admin/developer/architecture docs)
