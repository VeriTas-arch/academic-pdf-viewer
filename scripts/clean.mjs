import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const assets = resolve(root, 'assets', 'academic');
const entries = await readdir(assets, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') {
        throw error;
    }
    return [];
});

await Promise.all([
    rm(resolve(root, 'out'), { force: true, recursive: true }),
    rm(resolve(root, 'tmp', 'webview-build'), { force: true, recursive: true }),
    ...entries.filter(entry => entry.isFile() && /\.m?js$/.test(entry.name))
        .map(entry => rm(resolve(assets, entry.name), { force: true })),
]);
