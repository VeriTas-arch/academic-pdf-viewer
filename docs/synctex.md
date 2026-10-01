# SyncTeX integration

Academic PDF Viewer provides both an opt-in local command-line bridge and a transport API for TeX extensions. Set `academicPdfViewer.tex.synctex` to choose whether a PDF double-click or context-menu action requests inverse synchronization.

## Built-in bridge

Enable `academicPdfViewer.tex.bridge.enabled` in a trusted workspace to use a local SyncTeX executable directly. The bridge was designed and tested with MiKTeX `synctex.exe` and expects its `view`/`edit` command-line protocol. Compatible `synctex` executables from other distributions may also work, but ConTeXt `mtxrun --script synctex` uses different commands and output formats and is not currently supported by the bridge; integrate it through the extension API instead.

By default, forward search maps the active `.tex` file to a sibling PDF with the same base name. If the PDF is written elsewhere, set `academicPdfViewer.tex.bridge.pdfPath` to its absolute path or to a path relative to the workspace folder. Set `academicPdfViewer.tex.bridge.executable` when a compatible `synctex` executable is not on `PATH`.

With the bridge enabled:

- Run **TeX: SyncTeX Forward Search** from the `.tex` editor title bar, editor context menu, or Command Palette. No default keybinding is claimed; bind this command in VS Code's Keyboard Shortcuts editor if desired.
- Double-click the PDF for inverse search when `academicPdfViewer.tex.synctex` is `doubleclick`, or use the page context menu when it is `rightclick`.

The bridge supports local `file:` documents only, invokes the configured executable without a shell, and does not run in an untrusted workspace. The configured executable must be able to locate and parse a matching `.synctex` or `.synctex.gz` sidecar.

Forward-search precision is limited by the SyncTeX producer. MiKTeX can return the same PDF point and enclosing box for different columns on one source line; in that case, the viewer intentionally highlights the complete returned line box. For inverse search, the bridge uses an unambiguous PDF text hint to recover the source column when SyncTeX reports `Column:-1`, and otherwise selects the resolved source line.

## Extension API

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

[Back to README](https://github.com/VeriTas-arch/academic-pdf-viewer/blob/main/README.md#advanced)
