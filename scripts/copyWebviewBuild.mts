import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(projectRoot, 'tmp', 'webview-build');
const webviewBuildRoot = join(buildRoot, 'webview');
const outputRoot = join(projectRoot, 'assets', 'academic');

await mkdir(outputRoot, { recursive: true });
for (const entry of await readdir(webviewBuildRoot, { withFileTypes: true })) {
    if (entry.isFile() && (extname(entry.name) === '.js' || extname(entry.name) === '.mjs')) {
        await copyFile(join(webviewBuildRoot, entry.name), join(outputRoot, entry.name));
    }
}
await copyFile(
    join(buildRoot, 'shared', 'extensionMessages.js'),
    join(outputRoot, 'extensionMessages.js'),
);
await rm(buildRoot, { recursive: true, force: true });
