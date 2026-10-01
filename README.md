<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer"><img src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/icon.png" alt="Academic PDF Viewer icon" width="88"></a>
</p>

<h1 align="center">Academic PDF Viewer</h1>

<p align="center">
  <strong>Read papers. Inspect references. Review PDF revisions.</strong>
  <br>
  <sub>An academic PDF reader inside VS Code, powered by PDF.js.</sub>
</p>

<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer/releases"><img alt="Latest preview release" src="https://img.shields.io/github/v/release/VeriTas-arch/academic-pdf-viewer?include_prereleases&amp;label=preview&amp;color=7c3aed&amp;style=flat-square"></a>
  <img alt="VS Code 1.134 or later" src="https://img.shields.io/badge/VS%20Code-1.134%2B-007ACC?logo=visualstudiocode&amp;logoColor=white&amp;style=flat-square">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/VeriTas-arch/academic-pdf-viewer?color=2563eb&amp;style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/VeriTas-arch/academic-pdf-viewer/releases"><strong>Download Preview VSIX →</strong></a>
</p>

<p align="center">
  <a href="#install-and-start-reading">Get started</a>
  ·
  <a href="#preview-internal-references">Link previews</a>
  ·
  <a href="#review-pdf-revisions-preview">Git PDF review</a>
  ·
  <a href="#shortcuts-and-commands">Shortcuts</a>
  ·
  <a href="#integrate-with-synctex">SyncTeX</a>
  ·
  <a href="#settings">Settings</a>
</p>

<br>

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/snapshot.png"
    alt="Previewing the destination of a figure link inside an academic PDF"
    width="100%"
  >
  <br>
  <sub><strong>Link previews</strong> · Hold <kbd>Ctrl</kbd> over an embedded reference to inspect its destination.</sub>
</p>

<hr>

## Install and start reading

<blockquote>
  <p><strong>Preview build · VS Code 1.134+</strong><br>
  Enable Proposed API access for <code>customEditorDiffs</code>, including when using the extension as an ordinary PDF reader.</p>
</blockquote>

1. Download the `.vsix` from [GitHub Releases](https://github.com/VeriTas-arch/academic-pdf-viewer/releases).
2. Run **Extensions: Install from VSIX...** in VS Code and select the file.
3. Fully quit all VS Code windows, then launch from an external PowerShell window:

   ```powershell
   code --enable-proposed-api ovolab-veritas.academic-pdf-viewer --new-window .
   ```

4. Open a `.pdf`. If another editor opens, choose **Reopen Editor With...** → **Academic PDF Viewer** from the tab context menu.

Use the PDF.js toolbar for search, zoom, outline, page navigation, text selection, printing, and download.

<details>
<summary><strong>More installation options</strong> — command line &amp; persistent API access</summary>

Install or update from PowerShell:

```powershell
code --install-extension .\academic-pdf-viewer-x.y.z.vsix --force
```

To enable access on every launch, run **Preferences: Configure Runtime Arguments** and add this field to `argv.json`, preserving existing fields and extension IDs:

```json
{
    "enable-proposed-api": ["ovolab-veritas.academic-pdf-viewer"]
}
```

Fully restart VS Code afterward. Insiders is not required. Proposed APIs can change between versions; keep VS Code and the extension aligned.

</details>

## Preview internal references

For PDFs with embedded links to citations, figures, equations, or sections:

1. Hold <kbd>Ctrl</kbd> while hovering over a linked reference.
2. Read the destination preview; move into the popup to scroll it while holding Control.
3. Release Control to close it, or click the original link to navigate normally.

PDFs without internal link annotations remain readable but cannot provide previews. Preview quality depends on the PDF's destinations and text layer.

## Review PDF revisions *(Preview)*

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VeriTas-arch/academic-pdf-viewer/main/image/git_diff.png"
    alt="Git PDF comparison with the Index revision on the left and Working Tree revision on the right"
    width="100%"
  >
  <br>
  <sub><strong>Git PDF review</strong> · Removed regions on the left; inserted or replaced regions on the right.</sub>
</p>

After [Preview installation](#install-and-start-reading), open a changed or staged PDF from Source Control for side-by-side comparison. Badges distinguish `HEAD`, `Index`, and `Working Tree` when available.

- Toggle highlights and move between semantic changes using the title-bar controls.
- Scroll positions stay synchronized; zoom remains independent on each side.
- Use `PDF: Reload` after a file or Git revision changes; both sides reload together.

Pages are compared on demand, so navigating across many uncached or complex pages can take longer.

## Shortcuts and commands

<table width="100%">
  <thead>
    <tr><th align="left">Action</th><th align="left">Default shortcut</th><th align="left">Availability</th></tr>
  </thead>
  <tbody>
    <tr><td>Back / forward</td><td>Mouse Back / Forward<br><kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd></td><td>Any viewer tab</td></tr>
    <tr><td>Zoom around pointer</td><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Wheel</kbd></td><td>Any viewer tab</td></tr>
    <tr><td>Preview internal link</td><td>Hold <kbd>Ctrl</kbd> while hovering</td><td>PDFs with internal links</td></tr>
    <tr><td>Toggle diff highlights</td><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd></td><td>Active PDF diff</td></tr>
  </tbody>
</table>

`PDF: Reload`, `PDF: Toggle Link Preview`, and `PDF Diff: Previous Change` / `PDF Diff: Next Change` are available in the Command Palette when applicable. Assign custom bindings in VS Code's Keyboard Shortcuts editor.

<details>
<summary><strong>Navigation preferences</strong> — mouse buttons, shortcuts &amp; sidebar</summary>

Under **Academic PDF Viewer › Navigation**, enable Alt shortcuts and mouse side buttons independently, or change the mouse mapping from **Standard** to **Swapped**. `PDF: Navigate Back` and `PDF: Navigate Forward` remain available for custom bindings when the default Alt shortcuts are disabled.

**Navigation: Default Sidebar** selects Pages (default), Outline, Attachments, or Layers when the sidebar opens; it does not open the sidebar automatically. Unavailable views fall back to Pages, and `PDF: Reload` preserves the current view and open or closed state.

</details>

## Integrate with SyncTeX

For local TeX projects, enable `academicPdfViewer.tex.bridge.enabled` in a trusted workspace. The bridge uses a MiKTeX `synctex.exe`-compatible `view`/`edit` CLI and requires a matching `.synctex` or `.synctex.gz` file.

- From a `.tex` editor, run **TeX: SyncTeX Forward Search** using the title bar, context menu, or Command Palette. No default keybinding is assigned.
- Double-click the PDF for inverse search by default; choose `rightclick` or `off` with `academicPdfViewer.tex.synctex`.
- The target PDF defaults to a sibling file with the same base name. Set `academicPdfViewer.tex.bridge.pdfPath` for a different output location, or `academicPdfViewer.tex.bridge.executable` if the CLI is outside `PATH`.

<p><a href="https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/docs/synctex.md"><strong>SyncTeX guide →</strong></a><br>
Configuration, precision limits, and the complete extension API. ConTeXt <code>mtxrun</code>, remote, and virtual-workspace integrations should use that API.</p>

## Settings

Find all options under **Academic PDF Viewer** in VS Code Settings. The names below use the `academicPdfViewer.` prefix.

<table width="100%">
  <thead>
    <tr><th align="left">Setting</th><th align="left">Default &amp; behavior</th></tr>
  </thead>
  <tbody>
    <tr><td><code>linkPreview.enabled</code></td><td><code>true</code> · Control-hover previews. <code>PDF: Toggle Link Preview</code> changes this for the current window.</td></tr>
    <tr><td><code>linkPreview.resolutionScale</code></td><td><code>0</code> · Automatic screen-density adaptation, with at least 2 image pixels per CSS pixel. <code>1</code>–<code>4</code> select fixed density without changing popup size.</td></tr>
    <tr><td><code>tex.synctex</code></td><td><code>doubleclick</code> · Inverse SyncTeX trigger: <code>off</code>, <code>doubleclick</code>, or <code>rightclick</code>.</td></tr>
    <tr><td><code>tex.bridge.enabled</code></td><td><code>false</code> · Enables the local SyncTeX bridge in trusted workspaces.</td></tr>
  </tbody>
</table>

Higher preview densities use more memory and rendering time; large previews remain subject to pixel limits. Existing explicit values from `1` to `4` keep fixed-density behavior; set `0` for automatic adaptation.

## Troubleshooting and safety

<blockquote>
  <p>If PDF diffs stop opening after a VS Code update, check Proposed API access for <code>ovolab-veritas.academic-pdf-viewer</code> and fully restart VS Code.</p>
</blockquote>

<sub>PDF JavaScript evaluation remains disabled.</sub>

## Project links

<table width="100%">
  <tr>
    <td width="33%" align="center" valign="top">
      <a href="./CHANGELOG.md"><strong>Release notes</strong></a><br>
      <sub>Version history &amp; changes</sub>
    </td>
    <td width="34%" align="center" valign="top">
      <a href="https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/docs/development.md"><strong>Development</strong></a><br>
      <sub>Node.js 24.x · tests · fixtures<br>Packaging &amp; PDF.js maintenance</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <a href="./LICENSE"><strong>MIT License</strong></a><br>
      <sub>License terms</sub>
    </td>
  </tr>
</table>
