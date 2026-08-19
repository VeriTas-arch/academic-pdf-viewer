<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer"><img src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/icon.png" alt="Academic PDF Viewer icon" width="104"></a>
</p>

<h1 align="center">Academic PDF Viewer</h1>

<p align="center">
  <strong>Read papers, inspect internal references, and review Git PDF revisions—without leaving VS Code.</strong>
</p>

<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer/releases"><img alt="Latest preview release" src="https://img.shields.io/github/v/release/VeriTas-arch/academic-pdf-viewer?include_prereleases&label=preview&color=7c3aed"></a>
  <img alt="VS Code 1.133 or later" src="https://img.shields.io/badge/VS%20Code-1.133%2B-007ACC?logo=visualstudiocode&logoColor=white">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/VeriTas-arch/academic-pdf-viewer?color=2563eb"></a>
</p>

<p align="center">
  <a href="#start-reading">Get started</a>
  ·
  <a href="#preview-internal-references">Link previews</a>
  ·
  <a href="#review-pdf-revisions-preview">Git PDF review</a>
  ·
  <a href="#settings">Settings</a>
</p>

<br>

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/snapshot.png"
    alt="Previewing the destination of a figure link inside an academic PDF"
    width="88%"
  >
  <br>
  <sub>Hold Control over an embedded reference, figure, equation, or section link to inspect its destination.</sub>
</p>

<br>

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <h3>Read</h3>
      <p>Search, zoom, navigate, select text, and use outlines in the familiar PDF.js viewer.</p>
    </td>
    <td width="33%" align="center" valign="top">
      <h3>Preview</h3>
      <p>Inspect an internal link destination without losing your current reading position.</p>
    </td>
    <td width="33%" align="center" valign="top">
      <h3>Compare <sup>Preview</sup></h3>
      <p>Review changed or staged PDFs side by side with semantic highlights on both revisions.</p>
    </td>
  </tr>
</table>

> **Local-first reading:** PDF.js, its Worker, fonts, CMaps, and WASM assets are bundled with the extension. Opening local PDFs does not require an external service or network connection after installation.

## Start reading

1. Open any `.pdf` file in VS Code.
2. If another editor opens, right-click the tab and choose **Reopen Editor With...** → **Academic PDF Viewer**.
3. Use the standard PDF.js toolbar for search, zoom, outline, page navigation, text selection, printing, and download.

### Shortcuts and commands

| Action | Default shortcut | Availability |
| --- | --- | --- |
| Navigate back / forward inside the PDF | <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> | Any Academic PDF Viewer tab |
| Zoom around the pointer | <kbd>Ctrl/Cmd</kbd>+<kbd>Wheel</kbd> | Any Academic PDF Viewer tab |
| Open the VS Code Command Palette | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Routed to VS Code instead of PDF printing |
| Toggle diff highlights | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> / <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> | Active PDF diff |
| `PDF: Reload` | Assignable | Title bar or Command Palette; reloads both revisions in a diff |
| `PDF: Toggle Link Preview` | Assignable | Command Palette |
| `PDF Diff: Previous/Next Change` | Assignable | Title bar or Command Palette while highlights are enabled |

Commands without a default shortcut can be assigned from VS Code's Keyboard Shortcuts editor.

## Preview internal references

Many publisher and LaTeX-generated PDFs already contain links from citations, figures, equations, and section references to their destinations. Academic PDF Viewer uses those embedded annotations directly:

1. Hold <kbd>Ctrl</kbd> while the pointer is over a linked reference.
2. Read the cropped destination image and nearby text in the preview.
3. Release <kbd>Ctrl</kbd> to close it, or click the original link to navigate normally.

The popup does not capture pointer input, so links and the document outline remain clickable. PDFs without embedded link annotations still work as normal PDFs, but they cannot provide these previews.

For sharper preview images, increase `academicPdfViewer.linkPreview.resolutionScale`. This changes rendered resolution without enlarging the popup; higher values require more temporary memory and rendering time.

## Review PDF revisions *(Preview)*

> [!IMPORTANT]
> Git-aware PDF comparison depends on VS Code's proposed `customEditorDiffs` API. It is distributed as a Preview VSIX through [GitHub Releases](https://github.com/VeriTas-arch/academic-pdf-viewer/releases) and requires Proposed API access for this extension.

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/git_diff.png"
    alt="Git PDF comparison with the Index revision on the left and Working Tree revision on the right"
    width="100%"
  >
  <br>
  <sub>Removed regions appear on the original revision; inserted or replaced regions appear on the modified revision.</sub>
</p>

Open a changed or staged PDF from the Source Control view. VS Code places the tracked revision on the left and the selected Git revision on the right. Revision badges distinguish `HEAD`, `Index`, and `Working Tree` when that information is available.

- Toggle highlights from the title bar or with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> on macOS).
- Move between semantic changes with the title-bar arrows or the previous/next commands.
- Scroll position is synchronized by page and relative position; zoom remains independent on each side.
- Pages are compared on demand, with bounded background work for longer documents.
- Use `PDF: Reload` after the file or Git revision changes. Both sides reload together.

<details>
<summary><strong>Install and enable the Git diff Preview</strong></summary>

### 1. Install the VSIX

Download the `.vsix` from the Assets section of the corresponding [GitHub Release](https://github.com/VeriTas-arch/academic-pdf-viewer/releases), then run **Extensions: Install from VSIX...** in VS Code Insiders.

You can also install it from PowerShell:

```powershell
code-insiders --install-extension .\academic-pdf-viewer-x.y.z.vsix --force
```

### 2. Enable the Proposed API

For a one-time launch, fully quit VS Code Insiders and run:

```powershell
code-insiders --enable-proposed-api ovolab-veritas.academic-pdf-viewer --new-window .
```

The argument is the extension ID, not the proposal name. To enable it for every launch, run **Preferences: Configure Runtime Arguments** and add the extension ID to `argv.json` while preserving existing fields:

```json
{
    "enable-proposed-api": [
        "ovolab-veritas.academic-pdf-viewer"
    ]
}
```

Fully restart VS Code Insiders after changing `argv.json`. A compatible Stable build may work when it contains the same proposal; Insiders is the recommended environment because Proposed APIs can change between VS Code versions.

</details>

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `academicPdfViewer.linkPreview.enabled` | `true` | Shows a destination preview while holding <kbd>Ctrl</kbd> over an internal PDF link. |
| `academicPdfViewer.linkPreview.resolutionScale` | `2` | Sets rendered image pixels per CSS pixel from `1` to `4` without changing popup size. |

`PDF: Toggle Link Preview` changes the enabled setting for the current VS Code window.

## Requirements and limitations

- The current Preview build requires VS Code 1.133 or later.
- Git PDF review requires Proposed API access and can need adaptation after a VS Code update.
- Citation previews require native internal link annotations embedded in the PDF; GROBID-based extraction is not included.
- Preview quality depends on the PDF's link destinations and text layer.
- Moving across many unchanged or complex pages can take longer because cross-page diff navigation compares uncached pages on demand.
- PDF JavaScript evaluation remains disabled.

If Git PDF diffs stop opening after a VS Code update, verify the same workflow in VS Code Insiders before reporting an extension regression.

## Release notes

See [CHANGELOG.md](./CHANGELOG.md) for version history and notable changes.

<details>
<summary><strong>Development</strong></summary>

Use Node.js 24.x:

```bash
npm install
npm run check
npm test
npm run test:viewer
npm run test:extension
```

The tests remain independent from the normal build and VSIX prepublish path. `test:viewer` launches the bundled PDF.js viewer in a local Chromium-based browser; set `PLAYWRIGHT_BROWSER_EXECUTABLE` if the browser is outside its standard location. `test:extension` launches an isolated VS Code extension host.

Press <kbd>F5</kbd> in VS Code to open the manual fixtures with `customEditorDiffs` enabled. Before packaging, inspect the release contents:

```bash
npx @vscode/vsce ls --tree
npx @vscode/vsce package
```

PDF.js maintenance is explicit and separate from ordinary builds:

```bash
npm run pdfjs:check
npm run pdfjs:verify
npm run pdfjs:update -- --version x.y.z
```

See [AGENTS.md](./AGENTS.md) for repository boundaries, the verification matrix, and PDF.js update requirements.

</details>

## License

Licensed under the [MIT License](./LICENSE).
