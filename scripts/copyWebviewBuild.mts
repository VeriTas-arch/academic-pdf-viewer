import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const buildRoot = join(projectRoot, 'tmp', 'webview-build');
const webviewBuildRoot = join(buildRoot, 'webview');
const outputRoot = join(projectRoot, 'assets', 'academic');

await mkdir(outputRoot, { recursive: true });
for (const entry of await readdir(webviewBuildRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.m?js$/.test(entry.name)) {
        await copyFile(join(webviewBuildRoot, entry.name), join(outputRoot, entry.name));
    }
}
await copyFile(
    join(buildRoot, 'shared', 'extensionMessages.js'),
    join(outputRoot, 'extensionMessages.js'),
);
await rm(buildRoot, { recursive: true, force: true });
