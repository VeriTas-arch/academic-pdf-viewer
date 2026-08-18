# Change Log

All notable changes to the Academic PDF Viewer extension are documented in this file.

## [1.0.5] - 2026-08-18

### Security

- Explicitly disabled PDF.js JavaScript evaluation while retaining the existing PDF scripting and webview CSP restrictions.
- Added runtime validation for messages crossing from the PDF webview into the extension host.
- Rejected local and Git-backed PDF data above 512 MiB before loading the complete document into extension memory.

### Changed

- Cleaned generated extension and webview output before release builds to prevent stale files from entering the VSIX.

## [1.0.4] - 2026-08-18

### Added

- Added side-by-side custom editor diffs for modified and staged PDFs through VS Code's proposed `customEditorDiffs` API.
- Added optional changed-region highlights on the modified PDF, using text-aware comparison with a raster fallback.
- Added `Ctrl+Alt+D` (`Cmd+Alt+D` on macOS) as the default shortcut for toggling PDF diff highlights.
- Added development-only diagnostic logging for document loading, PDF.js initialization, Worker startup, citation previews, and PDF diff computation.

### Changed

- Upgraded the bundled PDF.js viewer to 6.2.108.
- Loaded the bundled PDF.js Worker through a local Blob URL, keeping PDF viewing offline while retaining a main-thread fallback.
- Expanded the README with core workflows, Preview VSIX installation, Proposed API setup, settings, requirements, and release documentation.

### Fixed

- Restored citation preview images after the PDF.js upgrade by using the current viewport coordinate API.
- Kept `Ctrl/Cmd+Shift+P` routed to the VS Code command palette during PDF.js startup.
- Corrected loading for normal, modified, and staged PDF resources in both standalone and Git diff editors.

## [1.0.3] - 2026-08-06

### Added

- Added a `PDF: Reload` editor action that reloads the active PDF from disk while preserving its current reading position.
- Added a persistent `academicPdfViewer.linkPreview.enabled` setting and `PDF: Toggle Link Preview` command for completely disabling or re-enabling link previews.

### Changed

- Changed destination previews from automatic hover to explicit `Ctrl`-hover so ordinary link and outline navigation remains unobstructed.
- Made previews open immediately when `Ctrl` is pressed over an already-hovered link, while retaining a 200 ms delay when entering a link with `Ctrl` already held.
- Made preview popups pointer-transparent and cancel pending rendering when `Ctrl` is released or the PDF webview loses focus.

### Fixed

- Prevented destination preview popups from intercepting clicks intended for PDF links or the outline in constrained editor layouts.
- Reloaded PDFs through a cache-busted URL so changes on disk become visible without reopening the editor.

## [1.0.2] - 2026-07-10

### Changed

- Enabled strict TypeScript checks for webview sources.
- Improved cached citation preview display so repeated hovers can render without a loading state.
- Scoped custom editor panel event subscriptions to panel lifetime.
- Centralized PDF.js private API access behind small helper functions.
- Cleaned VSIX packaging rules and removed template/legacy build artifacts from the workspace.

## [1.0.1] - 2026-07-09

### Changed

- Improved `Ctrl/Cmd+Wheel` zoom responsiveness with requestAnimationFrame batching and cursor-centered scroll preservation.
- Debounced citation overlay rebuilding during PDF.js CSS transform zoom updates.
- Routed `Ctrl/Cmd+Shift+P` from the PDF webview back to the VS Code command palette while suppressing PDF.js print handling.
- Disabled dragging inside citation preview popups to avoid corrupting the active PDF view.
- Refined README, extension metadata, and VSIX packaging rules for the initial marketplace-ready release.

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
