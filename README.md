# Academic PDF Viewer

Academic PDF Viewer brings paper reading and PDF revision review into VS Code. It opens `.pdf` files in a full PDF.js-based viewer and adds academic link previews, navigation history, and Git-aware visual comparison.

> **Read, preview, and compare PDFs without leaving VS Code**
>
> - **Read:** Search, zoom, navigate, and select text with the familiar PDF.js viewer.
> - **Preview:** Hold `Ctrl` over a linked citation, figure, equation, or section to preview its destination.
> - **Compare (Preview):** Open a changed or staged PDF from Source Control to view both Git revisions side by side, with optional changed-region highlights.

<p align="center">
  <img
    src="https://raw.githubusercontent.com/veritas-arch/academic-pdf-viewer/main/image/snapshot.png"
    alt="Academic PDF Viewer citation preview"
    width="85%"
  >
</p>

## Contents

- [Features](#features)
- [Getting Started](#getting-started)
- [Citation Preview](#citation-preview)
- [Git Diff Preview Build](#git-diff-preview-build)
- [Extension Settings](#extension-settings)
- [Requirements](#requirements)
- [Known Limitations](#known-limitations)
- [Release Notes](#release-notes)
- [Development](#development)
- [License](#license)

## Features

- Opens PDFs as the default custom editor in VS Code.
- Uses the full PDF.js viewer interface for search, zoom, outline, page navigation, text selection, and annotation layers.
- Opens changed and staged PDFs as side-by-side Git diffs and can highlight changed regions in the modified revision (Preview).
- Previews linked citations, figures, equations, and sections with a cropped destination image and nearby text.
- Keeps native PDF links clickable for direct navigation.
- Maintains an internal PDF navigation history for `Alt+Left` and `Alt+Right`.
- Improves `Ctrl/Cmd+Wheel` zoom responsiveness inside the webview.
- Keeps `Ctrl/Cmd+Shift+P` available for the VS Code command palette instead of PDF printing.
- Bundles PDF.js and its Worker so local PDFs remain available offline.

## Getting Started

Open any `.pdf` file in VS Code. The extension registers `Academic PDF Viewer` as the default PDF custom editor.

If another editor is selected, right-click the PDF tab, choose `Reopen Editor With...`, and select `Academic PDF Viewer`.

| Action | Default shortcut | Notes |
| --- | --- | --- |
| Navigate back | `Alt+Left` | Moves through the PDF viewer's internal navigation history. |
| Navigate forward | `Alt+Right` | Moves forward after navigating back. |
| Zoom around the pointer | `Ctrl/Cmd+Wheel` | Preserves the reading position around the pointer. |
| Open the VS Code command palette | `Ctrl/Cmd+Shift+P` | Overrides PDF.js printing only while the PDF editor is active. |
| `PDF: Reload` | None | Also available from the editor title bar. |
| `PDF: Toggle Link Preview` | None | Enables or disables `Ctrl`-hover previews. |
| `PDF: Toggle Diff Highlights` | `Ctrl+Alt+D` (`Cmd+Alt+D` on macOS) | Available while a PDF diff editor is active. |

Commands without a default shortcut can be assigned from VS Code's Keyboard Shortcuts editor.

## Citation Preview

The current release uses citation and link annotations already embedded in the PDF. Many publisher and LaTeX-generated papers include these links for references, figures, equations, or sections. When such links are available, Academic PDF Viewer draws a lightweight overlay and shows a preview of the destination while you hold `Ctrl` and hover over the link. You can press `Ctrl` before moving onto the link or while the pointer is already over it; releasing `Ctrl` closes the preview.

The popup's displayed size is independent from its rendered image resolution.
Increase `academicPdfViewer.linkPreview.resolutionScale` for a sharper preview
without making the popup larger. Higher values require more rendering time and
temporary image memory.

PDFs without embedded citation/link annotations are still readable as normal PDFs, but citation previews may not appear.

Preview popups do not capture pointer input, so PDF links and the outline remain clickable while a preview is visible.

## Git Diff Preview Build

Git-aware PDF comparison is currently distributed as a Preview VSIX through [GitHub Releases](https://github.com/VeriTas-arch/academic-pdf-viewer/releases). It depends on VS Code's proposed `customEditorDiffs` API, so installing the VSIX alone is not enough: VS Code must also explicitly allow Proposed API access for this extension.

VS Code Insiders is the officially supported environment for Proposed API extensions. A Stable build may also work when it contains the same proposal (the current preview is tested with VS Code 1.133), but this is not guaranteed across VS Code updates.

<p align="center">
  <img
    src="https://raw.githubusercontent.com/veritas-arch/academic-pdf-viewer/main/image/git_diff.png"
    alt="Academic PDF Viewer Git diff preview"
    width="100%"
  >
</p>

*Git-aware PDF comparison showing the tracked revision on the left, the working-tree revision on the right, and optional changed-region highlights.*

### Install the Preview VSIX

1. Download the `.vsix` file from the Assets section of the corresponding [GitHub Release](https://github.com/VeriTas-arch/academic-pdf-viewer/releases).
2. In VS Code Insiders, run `Extensions: Install from VSIX...` from the Command Palette and select the downloaded file.
3. Fully quit VS Code Insiders before enabling the Proposed API. Make sure no existing window remains open.

You can also install or update the VSIX from PowerShell:

```powershell
code-insiders --install-extension .\academic-pdf-viewer-x.y.z.vsix --force
```

### Enable the Proposed API

For a one-time launch, start VS Code Insiders from an external PowerShell window:

```powershell
code-insiders --enable-proposed-api ovolab-veritas.academic-pdf-viewer --new-window .
```

The value after `--enable-proposed-api` is the extension ID, not the proposal name `customEditorDiffs`.

To enable the Preview build on every launch:

1. Run `Preferences: Configure Runtime Arguments` from the Command Palette.
2. Add the extension ID to `argv.json`, preserving any existing fields:

   ```json
   {
       "enable-proposed-api": [
           "ovolab-veritas.academic-pdf-viewer"
       ]
   }
   ```

3. Fully restart VS Code Insiders.

When testing with a compatible VS Code Stable build, replace `code-insiders` with `code` in the commands above. If Git PDF diffs stop opening after a VS Code update, verify the behavior in Insiders before reporting an extension regression.

### Review PDF Changes

1. Open a folder containing a Git repository.
2. Modify or stage a tracked PDF.
3. Select the PDF entry in the Source Control view. VS Code opens the relevant Git revisions side by side with the original revision on the left and the modified revision on the right.
4. Press `Ctrl+Alt+D` (`Cmd+Alt+D` on macOS), or run `PDF: Toggle Diff Highlights`, to show or hide changed-region markers on the modified PDF.

The revision pair follows the Source Control entry selected by VS Code. PDFs that are not being compared continue to open as normal PDF editors.

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `academicPdfViewer.linkPreview.enabled` | `true` | Shows a destination preview while holding `Ctrl` over an internal PDF link. |
| `academicPdfViewer.linkPreview.resolutionScale` | `2` | Sets rendered image pixels per CSS pixel from `1` to `4`, without changing the displayed preview size. |

The `PDF: Toggle Link Preview` command updates this setting for the current VS Code window.

## Requirements

- Stable builds without Git Diff require VS Code 1.125 or later.
- GitHub Preview VSIX builds require VS Code Insiders (recommended) or a compatible Stable build launched with Proposed API access enabled for this extension.
- A PDF with embedded internal link annotations for citation and destination previews.
- A Git repository and a compatible Proposed API-enabled VS Code build for Git PDF comparison.
- No external service or network connection is required to open local PDFs after installation.

## Known Limitations

- Git PDF comparison depends on the unstable `customEditorDiffs` Proposed API and can require changes after a VS Code update.
- Citation detection currently depends on native PDF link annotations.
- Preview quality depends on the PDF's embedded link destinations and text layer.
- GROBID-based citation extraction is not included in this release.

## Release Notes

See [CHANGELOG.md](./CHANGELOG.md) for version history and notable changes.

## Development

Use Node.js 24.x for local development.

```bash
npm install
npm run check
```

Run the local tests explicitly when needed; they are not part of the build or
VSIX prepublish path:

```bash
npm test
```

Launch the extension host from VS Code with `F5`, then open a PDF file.

PDF.js maintenance is also explicit and independent from the normal build and
packaging paths:

```bash
npm run pdfjs:check
npm run pdfjs:verify
npm run pdfjs:update -- --version x.y.z
```

`pdfjs:check` is a read-only online release check. `pdfjs:verify` validates the
installed bundle offline. `pdfjs:update` requires an exact version, verifies the
official release asset checksum, stages and validates the candidate, and only
then replaces the vendored files. Review [VENDOR.md](./assets/pdfviewer/VENDOR.md)
and run the manual PDF smoke checks after an update.

Create a local VSIX package with:

```bash
npx @vscode/vsce package
```

## License

Licensed under the [MIT License](./LICENSE).
