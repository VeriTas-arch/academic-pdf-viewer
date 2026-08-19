import { rm } from 'node:fs/promises';

const generatedPaths = [
    'out',
    'assets/academic/citationPreview.js',
    'assets/academic/citationPreviewLines.js',
    'assets/academic/citationPreviewLines.mjs',
    'assets/academic/pdfDiff.js',
    'assets/academic/pdfDiffAlgorithm.mjs',
    'assets/academic/pdfjsAdapter.js',
    'assets/academic/pdfViewerBootstrap.js',
    'assets/academic/reader.js',
];

await Promise.all(generatedPaths.map(path => rm(path, { force: true, recursive: true })));
