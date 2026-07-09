# Change Log

All notable changes to the Academic PDF Viewer extension are documented in this file.

## [0.0.1] - 2026-07-09

### Added

- PDF.js-based custom editor for `.pdf` files.
- Native PDF link annotation overlays for citation-style targets.
- Hover previews with cropped destination images and nearby text.
- Citation/link click navigation.
- Internal PDF navigation history with `Alt+Left` and `Alt+Right`.
- Responsive `Ctrl/Cmd+Wheel` zoom handling inside the webview.
- VS Code command palette routing for `Ctrl/Cmd+Shift+P`.

### Changed

- Debounced citation overlay rebuilding during zoom.
- Disabled popup content dragging to avoid corrupting the active PDF webview.

### Known Limitations

- Citation previews require embedded PDF link annotations.
- GROBID-based citation extraction is not included.
