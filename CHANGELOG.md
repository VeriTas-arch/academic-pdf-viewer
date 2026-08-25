# Change Log

All notable changes to the Academic PDF Viewer extension are documented in this file.

## [1.3.0] - 2026-08-25

### Added

- Added a validated bidirectional SyncTeX transport API for forward PDF targets and inverse source requests, including optional line boxes and PDF text hints.
- Added an opt-in local SyncTeX command-line bridge for trusted workspaces, with configurable executable and PDF paths plus discoverable `.tex` editor actions without a default keybinding.
- Added a transient forward-search marker that highlights the complete SyncTeX line box when available.

### Changed

- Raised the minimum supported VS Code version to 1.134 to match the extension host and proposed API contract used by this release.

### Fixed

- Corrected forward-search coordinates for PDF page view boxes and user units, and queued requests until lazy PDF pages finish loading.
- Improved inverse search by recovering precise source columns from PDF text hints when SyncTeX reports an unknown column, with whole-line selection as a safe fallback.
- Scoped inverse right-click actions to PDF pages and made forward requests latest-wins across reloads and duplicate editor panels.

## [1.2.3] - 2026-08-22

### Added

- Added a configurable default sidebar view for Pages, Outline, Attachments, or Layers without forcing the sidebar open.

### Fixed

- Preserved the active sidebar view and its open or closed state when reloading a PDF, with unavailable views falling back to Pages.

## [1.2.2] - 2026-08-22

### Added

- Added mouse side-button navigation with independently configurable mouse and default Alt inputs, plus Standard and Swapped mouse-button mapping presets.
- Added browser-level regression coverage for both side-button mappings and reloads at non-preset zoom levels.

### Fixed

- Preserved exact non-preset zoom values, the current page, and scroll position when reloading a PDF.

## [1.2.1] - 2026-08-20

### Changed

- Limited each PDF diff pair to 512 MiB combined before copying revision data into the webviews, while preserving the existing per-document limit.
- Pinned the stable VS Code type package and recorded the VS Code 1.133 source of the vendored `customEditorDiffs` proposal contract.

### Fixed

- Rejected malformed PDF diff messages before they could replace active sessions, corrupt forwarded highlight state, or trigger webview errors.
- Honored editor-open and Proposed API cancellation tokens, including terminating active Git child processes without reporting cancellation as a read failure.

## [1.2.0] - 2026-08-19

### Added

- Added bounded background scheduling and cache-aware page comparison for responsive PDF diffs across both small and long documents.
- Added broader automated coverage for proportional text highlights, multi-rectangle selections, long-document prefetching, removed pages, missing Git revisions, and interactive citation previews.

### Changed

- Improved text-diff performance for mostly unchanged pages by trimming common token prefixes and suffixes before matching.
- Standardized same-line and paired replacement highlight geometry while preserving materially different text heights.
- Made Control-hover citation previews interactive while Control is held, including pointer movement into the popup and preview scrolling without triggering PDF zoom.

### Fixed

- Preserved non-text visual changes on pages that also contain semantic text differences.
- Made rapid consecutive reloads latest-wins across both extension-host reads and serialized PDF.js document loading.
- Distinguished missing Git paths from invalid refs and repository errors instead of treating every Git failure as an empty revision.
- Preserved empty-revision behavior for added and deleted Git PDFs while retaining the preflight file-size safety limit.
- Cleared every rectangle belonging to a selected multi-region change when navigating to another page.
- Restored citation fallback text selection before applying the four-line preview limit.

## [1.1.2] - 2026-08-19

### Added

- Added an independently invoked browser smoke test for the bundled PDF.js viewer, covering offline Worker startup, first-page rendering, VS Code shortcut routing, and both Control-hover input orders.
- Added a compact, reproducible Typst and PDF fixture for viewer integration tests.
- Added a PDF.js compatibility adapter that centralizes private viewer hooks, page enumeration, fingerprint overrides, and upstream DOM anchors.

### Fixed

- Precomputed PDF diff highlights for every page in small documents, applied original-only removed-page markers without manual navigation, and maintained a bounded seven-page comparison window while scrolling longer documents.

## [1.1.1] - 2026-08-19

### Added

- Added on-demand cross-page navigation for PDF diff highlights without pre-scanning the full document.

### Changed

- Renamed the previous and next diff commands to reflect document-wide navigation.
- Isolated each highlight computation behind a diff session identifier so reloads, rapid toggles, and reopened editors reject stale page and navigation results.
- Cleaned up both sides of a diff pair when either webview is disposed.

### Fixed

- Preserved left-side deletion navigation and right-side addition or replacement navigation across page boundaries, including revisions with different page counts.
- Displayed newly rendered link-preview canvases immediately while PNG cache encoding continues in the background, removing avoidable first-hover loading time without lowering configured image clarity.
- Made Control-hover previews use citation-rectangle hit testing, including text glyphs that sit above the preview overlay and stationary pointers after page rerenders or wheel zooming.

## [1.1.0] - 2026-08-19

### Added

- Added semantic PDF diff highlights on both revisions: removed content is marked on the original, while added or replaced content is marked on the modified revision.
- Added stable revision and highlight-state badges inside PDF diff viewers.
- Added diff-editor title actions for showing or hiding highlights and navigating changed regions on the current page.
- Added bidirectional vertical scroll synchronization using page-relative anchors, with whole-document progress fallback when one revision lacks the corresponding page.

### Changed

- Computed text differences as separate original and modified regions, fixing deletion-only markers that previously used original coordinates on the modified page.
- Reused each page comparison result across both webviews and preserved bounded page caches and comparison concurrency.
- Raised the minimum VS Code version to 1.133 for the current `customEditorDiffs` Preview API contract.

### Fixed

- Marked new, deleted, dimension-changed, and trailing removed PDF pages on the revision where the change actually occurs.
- Reloaded both revisions together in a PDF diff so manually refreshed highlights cannot compare a new side against a stale baseline.
- Refined PDF diff status labels with neutral toolbar styling, white dark-theme text, hollow or solid role indicators, and fixed on/off wording that does not flicker while pages are compared.

## [1.0.7] - 2026-08-19

### Added

- Added a user-configurable link-preview resolution scale that increases image clarity without changing the popup's displayed size.
- Added independent PDF.js release check, staged update, and offline verification commands backed by machine-readable vendor metadata.
- Added project development guidance for local testing, packaging, Proposed API use, and PDF.js maintenance.

### Changed

- Rendered citation previews as revocable Blob URLs, bounded preview and PDF diff caches, and limited page comparisons to two concurrent tasks for long documents.
- Added TypeScript checking and linting for the PDF.js maintenance tool.
- Corrected the extension development launch target after the fixture directory was renamed to `manual-tests`.

### Security

- Removed the unused PDF.js scripting sandbox and QuickJS assets while keeping PDF JavaScript evaluation disabled.

## [1.0.6] - 2026-08-18

### Added

- Added independently invoked local tests for webview message validation and the raster PDF diff algorithm.

### Changed

- Migrated the extension-owned PDF.js viewer bootstrap from handwritten JavaScript to strict TypeScript.
- Split PDF data access, viewer HTML rendering, and diagnostic logging out of the custom editor provider.
- Extracted the raster comparison algorithm into a small testable module without changing the diff overlay behavior.
- Replaced permissive PDF.js `any` boundaries with the minimal interfaces used by the extension.
- Enabled stricter TypeScript and ESLint checks for unused code, control flow, and explicit `any` usage.

### Removed

- Removed unused extension context state, duplicated protocol literals, and obsolete configurable viewer defaults.

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
