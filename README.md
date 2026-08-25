<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer"><img src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/icon.png" alt="Academic PDF Viewer icon" width="104"></a>
</p>

<h1 align="center">Academic PDF Viewer</h1>

<p align="center">
  <strong>Read papers, inspect internal references, and review Git PDF revisions—without leaving VS Code.</strong>
</p>

<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer/releases"><img alt="Latest preview release" src="https://img.shields.io/github/v/release/VeriTas-arch/academic-pdf-viewer?include_prereleases&label=preview&color=7c3aed"></a>
  <img alt="VS Code 1.134 or later" src="https://img.shields.io/badge/VS%20Code-1.134%2B-007ACC?logo=visualstudiocode&logoColor=white">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/VeriTas-arch/academic-pdf-viewer?color=2563eb"></a>
</p>

<p align="center">
  <a href="#install-and-start-reading">Get started</a>
  ·
  <a href="#preview-internal-references">Link previews</a>
  ·
  <a href="#integrate-with-synctex">SyncTeX API</a>
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
      <h3>Inspect</h3>
      <p>Inspect an internal link destination without losing your current reading position.</p>
    </td>
    <td width="33%" align="center" valign="top">
      <h3>Compare</h3>
      <p>Review changed or staged PDFs side by side with semantic highlights on both revisions.</p>
    </td>
  </tr>
</table>

## Install and start reading

The current build is distributed as a Preview VSIX through [GitHub Releases](https://github.com/VeriTas-arch/academic-pdf-viewer/releases). Because it declares VS Code's proposed `customEditorDiffs` API, Proposed API access must be enabled for this extension even when using it as a regular PDF reader.

1. Download the `.vsix` from the Assets section of the corresponding GitHub Release.
2. In the latest stable version of VS Code, run **Extensions: Install from VSIX...** and select the downloaded file.
3. Fully quit VS Code so no existing window remains open.
4. Launch it from an external PowerShell window:

```powershell
code --enable-proposed-api ovolab-veritas.academic-pdf-viewer --new-window .
```

<details>
<summary><strong>Command-line installation and persistent Proposed API access</strong></summary>

Install or update the VSIX from PowerShell:

```powershell
code --install-extension .\academic-pdf-viewer-x.y.z.vsix --force
```

To enable the Preview build on every launch, run **Preferences: Configure Runtime Arguments** and add the extension ID to `argv.json` while preserving existing fields:

```json
{
    "enable-proposed-api": [
        "ovolab-veritas.academic-pdf-viewer"
    ]
}
```

Fully restart VS Code after changing `argv.json`. VS Code Insiders is not required; the latest stable version supports the proposal used by this build. Proposed APIs can still change between VS Code versions, so keep VS Code and the extension version aligned.

</details>

After installation:

1. Open any `.pdf` file in VS Code.
2. If another editor opens, right-click the tab and choose **Reopen Editor With...** → **Academic PDF Viewer**.
3. Use the standard PDF.js toolbar for search, zoom, outline, page navigation, text selection, printing, and download.

### Shortcuts and commands

| Action | Default shortcut | Availability |
| --- | --- | --- |
| Navigate back / forward inside the PDF | Mouse Back / Forward or <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> | Any Academic PDF Viewer tab |
| Zoom around the pointer | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Wheel</kbd> | Any Academic PDF Viewer tab |
| Preview an internal link destination | Hold <kbd>Ctrl</kbd> while hovering | PDFs with embedded internal links |
| Toggle diff highlights | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> | Active PDF diff |

The built-in Alt shortcuts and mouse side buttons can be enabled independently under **Academic PDF Viewer › Navigation** in Settings. The mouse-button mapping defaults to **Standard** (Back → back, Forward → forward) and can be changed to **Swapped** (Back → forward, Forward → back). `PDF: Navigate Back` and `PDF: Navigate Forward` remain available in VS Code's Keyboard Shortcuts editor, so disabling the default Alt shortcuts does not prevent custom keyboard bindings.

The sidebar defaults to **Pages**. Set **Academic PDF Viewer › Navigation: Default Sidebar** to **Outline**, **Attachments**, or **Layers** to select that view when the sidebar opens. The sidebar remains closed until opened; `PDF: Reload` preserves its current view and open or closed state, and PDFs without the selected view fall back to Pages.

`PDF: Reload`, `PDF: Toggle Link Preview`, and the previous/next diff commands are available from the title bar or Command Palette when applicable. They can also be assigned from VS Code's Keyboard Shortcuts editor.

## Integrate with SyncTeX

Academic PDF Viewer provides both an opt-in local command-line bridge and a transport API for TeX extensions. Set `academicPdfViewer.tex.synctex` to choose whether a PDF double-click or context-menu action requests inverse synchronization.

### Built-in bridge

Enable `academicPdfViewer.tex.bridge.enabled` in a trusted workspace to use the `synctex` executable directly. By default, forward search maps the active `.tex` file to a sibling PDF with the same base name. If the PDF is written elsewhere, set `academicPdfViewer.tex.bridge.pdfPath` to its absolute path or to a path relative to the workspace folder. Set `academicPdfViewer.tex.bridge.executable` when `synctex` is not on `PATH`.

With the bridge enabled:

- Run **TeX: SyncTeX Forward Search** from the `.tex` editor title bar, editor context menu, or Command Palette. No default keybinding is claimed; bind this command in VS Code's Keyboard Shortcuts editor if desired.
- Double-click the PDF for inverse search when `academicPdfViewer.tex.synctex` is `doubleclick`, or use the page context menu when it is `rightclick`.

The bridge supports local `file:` documents only, invokes the configured executable without a shell, and does not run in an untrusted workspace. The TeX build must have generated a matching `.synctex.gz` file.

### Extension API

The public API remains available for TeX extensions that manage their own build directories, source roots, remote environments, or SyncTeX process.

From your extension's `activate` function, activate Academic PDF Viewer and subscribe to inverse requests through its exported API:

```ts
interface SyncTexForwardRequest {
    type: 'synctex.forward';
    pdfUri: string;
    pageNumber: number;
    x: number;
    y: number;
    targetBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

interface SyncTexInverseEvent extends Omit<SyncTexForwardRequest, 'type' | 'targetBox'> {
    type: 'synctex.inverse';
    trigger: 'doubleClick' | 'rightClick';
    context?: string;
    offset?: number;
}

interface AcademicPdfViewerApi {
    readonly tex: {
        readonly onDidRequestInverseSyncTex: vscode.Event<SyncTexInverseEvent>;
        synctexForward(request: SyncTexForwardRequest): boolean;
    };
}

const extension = vscode.extensions.getExtension<AcademicPdfViewerApi>(
    'ovolab-veritas.academic-pdf-viewer',
);
if (!extension) {
    return;
}
const api = await extension.activate();
const subscription = api.tex.onDidRequestInverseSyncTex((request: SyncTexInverseEvent) => {
    // Resolve request.pdfUri and map this PDF position back to a TeX source position.
});
context.subscriptions.push(subscription);
```

For forward synchronization, call the API method or execute the registered command:

```ts
const request: SyncTexForwardRequest = {
    type: 'synctex.forward',
    pdfUri: pdfUri.toString(),
    pageNumber: 3,
    x: 144,
    y: 216,
};

const accepted = api.tex.synctexForward(request);
// Alternative for integrations that do not use the exported API:
const commandAccepted = await vscode.commands.executeCommand<boolean>(
    'academicPdfViewer.tex.synctexForward',
    request,
);
```

The public command requires the complete request object, so an external TeX
integration should expose its own source-side command that runs SyncTeX and then
calls this API.

`pdfUri` is the canonical URI string produced by `vscode.Uri.toString()`, including its scheme and any query or fragment. `pageNumber` is one-based. `x` and `y` are PDF coordinates measured from the top-left corner in 72-dpi points. `targetBox`, when available, uses the same coordinate system and describes the enclosing SyncTeX line box from its top-left corner. A `true` forward result means that a matching open document accepted and queued the request; the latest request for that document wins. A `false` result means that the request was invalid or no matching document was open.

An applied forward request briefly highlights `targetBox` when supplied, or
falls back to marking the reported PDF point, and keeps the target inside the
visible area. Inverse requests can additionally include `context`
from the PDF text layer and the zero-based `offset` of the clicked character in
that text. Integrations may pass those fields to SyncTeX's content hint and use
them to recover a source column when the SyncTeX producer reports `Column:-1`;
the fields are absent when no reliable text-layer hit is available.

## Preview internal references

Many publisher and LaTeX-generated PDFs already contain links from citations, figures, equations, and section references to their destinations. Academic PDF Viewer uses those embedded annotations directly:

1. Hold <kbd>Ctrl</kbd> while the pointer is over a linked reference.
2. Read the cropped destination image and nearby text in the preview.
3. Release <kbd>Ctrl</kbd> to close it, or click the original link to navigate normally.

While Control is held, you can move into the popup and scroll its preview. Release Control to close it; the original PDF links and document outline remain clickable during normal reading. PDFs without embedded link annotations still work as normal PDFs, but they cannot provide these previews.

For sharper preview images, increase `academicPdfViewer.linkPreview.resolutionScale`. This changes rendered resolution without enlarging the popup; higher values require more temporary memory and rendering time.

## Review PDF revisions *(Preview)*

> [!IMPORTANT]
> Git-aware PDF comparison depends on VS Code's proposed `customEditorDiffs` API. Complete the [Preview installation](#install-and-start-reading) before opening PDF revisions from Source Control.

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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `academicPdfViewer.linkPreview.enabled` | `true` | Shows a destination preview while holding <kbd>Ctrl</kbd> over an internal PDF link. |
| `academicPdfViewer.linkPreview.resolutionScale` | `2` | Sets rendered image pixels per CSS pixel from `1` to `4` without changing popup size. |
| `academicPdfViewer.tex.synctex` | `doubleclick` | Chooses `off`, `doubleclick`, or `rightclick` for inverse SyncTeX requests. |
| `academicPdfViewer.tex.bridge.enabled` | `false` | Enables the local SyncTeX command-line bridge in a trusted workspace. |
| `academicPdfViewer.tex.bridge.executable` | `synctex` | Sets the SyncTeX executable name or path, without additional arguments. |
| `academicPdfViewer.tex.bridge.pdfPath` | empty | Overrides the forward-search PDF path; relative paths start at the workspace folder. |

`PDF: Toggle Link Preview` changes the enabled setting for the current VS Code window.

## Requirements and limitations

- The current Preview build requires VS Code 1.134 or later.
- Git PDF review requires Proposed API access and can need adaptation after a VS Code update.
- Citation previews require native internal link annotations embedded in the PDF; GROBID-based extraction is not included.
- Preview quality depends on the PDF's link destinations and text layer.
- The built-in bridge requires a local TeX installation that provides `synctex`; remote and virtual-workspace toolchains should use the extension API instead.
- Moving across many unchanged or complex pages can take longer because cross-page diff navigation compares uncached pages on demand.
- PDF JavaScript evaluation remains disabled.

If Git PDF diffs stop opening after a VS Code update, verify that Proposed API access remains enabled for `ovolab-veritas.academic-pdf-viewer`, then fully restart VS Code before reporting an extension regression.

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
