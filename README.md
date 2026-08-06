# Academic PDF Viewer

Academic PDF Viewer is a VS Code PDF reader focused on paper-reading workflows. It opens `.pdf` files directly in a PDF.js-based custom editor and adds citation-aware previews and navigation behavior on top of the standard PDF viewer experience.

![Academic PDF Viewer citation preview](https://raw.githubusercontent.com/veritas-arch/academic-pdf-viewer/main/image/snapshot.png)

## Features

- Opens PDFs as the default custom editor in VS Code.
- Uses the full PDF.js viewer interface for search, zoom, outline, page navigation, text selection, and annotation layers.
- Highlights native PDF citation/link annotations.
- Shows a `Ctrl`-hover preview for citation targets, including a cropped page image and nearby text.
- Clicks citation overlays to jump to the target reference or figure location.
- Maintains an internal PDF navigation history for `Alt+Left` and `Alt+Right`.
- Improves `Ctrl/Cmd+Wheel` zoom responsiveness inside the webview.
- Keeps `Ctrl/Cmd+Shift+P` available for the VS Code command palette instead of PDF printing.

## Usage

Open any `.pdf` file in VS Code. The extension registers `Academic PDF Viewer` as the default PDF custom editor.

Keyboard shortcuts:

- `Alt+Left`: navigate back within the PDF viewer history.
- `Alt+Right`: navigate forward within the PDF viewer history.
- `Ctrl/Cmd+Wheel`: zoom around the mouse position.
- `Ctrl/Cmd+Shift+P`: open the VS Code command palette.

Run `PDF: Toggle Link Preview` from the command palette to enable or disable `Ctrl`-hover previews. The choice is saved in the `academicPdfViewer.linkPreview.enabled` setting. You can assign your preferred shortcut to the command from VS Code's Keyboard Shortcuts editor.

## Citation Preview

The current release uses citation and link annotations already embedded in the PDF. Many publisher and LaTeX-generated papers include these links for references, figures, equations, or sections. When such links are available, Academic PDF Viewer draws a lightweight overlay and shows a preview of the destination while you hold `Ctrl` and hover over the link. You can press `Ctrl` before moving onto the link or while the pointer is already over it; releasing `Ctrl` closes the preview.

PDFs without embedded citation/link annotations are still readable as normal PDFs, but citation previews may not appear.

Preview popups do not capture pointer input, so PDF links and the outline remain clickable while a preview is visible.

## Known Limitations

- Citation detection currently depends on native PDF link annotations.
- Preview quality depends on the PDF's embedded link destinations and text layer.
- GROBID-based citation extraction is not included in this release.

## Development

```bash
npm install
npm run compile
npm run lint
```

Launch the extension host from VS Code with `F5`, then open a PDF file.
