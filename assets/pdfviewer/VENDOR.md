# PDF.js vendor

The runtime files under `lib/build` and `lib/web` come from the official PDF.js
6.2.108 generic distribution:

- Release: <https://github.com/mozilla/pdf.js/releases/tag/v6.2.108>
- Archive: `pdfjs-6.2.108-dist.zip`
- SHA-256: `7bf642d59582b475e8c48447da9b02b0108fad9742d7c2a35cb4ed6dd45e95ba`

Source maps, the debugger bundle, and the bundled example PDF are omitted because
they are not used at runtime. `lib/main.js` and `lib/pdf.css` are extension-owned
integration files and are not part of the upstream archive.
