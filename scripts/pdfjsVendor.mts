import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    access,
    cp,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

interface VendorMetadata {
    schemaVersion: 1;
    version: string;
    tag: string;
    asset: string;
    releaseUrl: string;
    sha256: string;
    excludeSourceMaps: boolean;
    excludedPaths: string[];
}

interface ReleaseAsset {
    name: string;
    downloadUrl: string;
    size: number;
    digest?: string;
}

interface Release {
    tag: string;
    url: string;
    assets: ReleaseAsset[];
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(projectRoot, 'assets', 'pdfviewer');
const libraryPath = join(vendorRoot, 'lib');
const metadataPath = join(vendorRoot, 'vendor.json');
const vendorMarkdownPath = join(vendorRoot, 'VENDOR.md');
const runFile = promisify(execFile);
const maximumArchiveBytes = 100 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const requiredFiles = [
    'LICENSE',
    'pdf.css',
    'build/pdf.mjs',
    'build/pdf.worker.mjs',
    'web/viewer.css',
    'web/viewer.html',
    'web/viewer.mjs',
    'web/locale/locale.json',
];
const requiredDirectories = [
    'web/cmaps',
    'web/iccs',
    'web/images',
    'web/locale',
    'web/standard_fonts',
    'web/wasm',
];
const viewerHtmlMarkers = [
    '<title>PDF.js viewer</title>',
    '<link rel="resource" type="application/l10n" href="locale/locale.json" />',
    '<script src="../build/pdf.mjs" type="module"></script>',
    '<link rel="stylesheet" href="viewer.css" />',
    '<script src="viewer.mjs" type="module"></script>',
];

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'verify') {
        requireNoArguments(args, command);
        const metadata = await verifyInstalledVendor();
        console.log(`[pdfjs] Verified bundled PDF.js ${metadata.version}.`);
        return;
    }
    if (command === 'check') {
        requireNoArguments(args, command);
        await checkForUpdate();
        return;
    }
    if (command === 'update') {
        await updateVendor(parseUpdateArguments(args));
        return;
    }
    throw new Error('Usage: pdfjsVendor.mts <check|verify|update --version x.y.z [--sha256 digest]>');
}

function requireNoArguments(args: string[], command: string): void {
    if (args.length > 0) {
        throw new Error(`The ${command} command does not accept arguments.`);
    }
}

function parseUpdateArguments(args: string[]): { version: string; sha256?: string } {
    let version: string | undefined;
    let sha256: string | undefined;
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!value || (name !== '--version' && name !== '--sha256')) {
            throw new Error(`Unsupported or incomplete update option: ${name ?? '<missing>'}`);
        }
        if (name === '--version') {
            version = value;
        } else {
            sha256 = normalizeSha256(value);
        }
    }
    if (!version || !versionPattern.test(version)) {
        throw new Error('The update command requires --version x.y.z.');
    }
    return { version, sha256 };
}

async function checkForUpdate(): Promise<void> {
    const current = await verifyInstalledVendor();
    const latest = await fetchRelease('latest');
    const latestVersion = latest.tag.startsWith('v') ? latest.tag.slice(1) : latest.tag;
    if (latestVersion === current.version) {
        console.log(`[pdfjs] ${current.version} is the latest official release.`);
        return;
    }
    console.log(`[pdfjs] Bundled: ${current.version}; latest: ${latestVersion}.`);
    console.log(`[pdfjs] Review the release, then run: npm run pdfjs:update -- --version ${latestVersion}`);
}

async function updateVendor(options: { version: string; sha256?: string }): Promise<void> {
    const current = await verifyInstalledVendor();
    const tag = `v${options.version}`;
    const release = await fetchRelease(`tags/${encodeURIComponent(tag)}`);
    if (release.tag !== tag) {
        throw new Error(`GitHub returned ${release.tag} for requested tag ${tag}.`);
    }
    const assetName = `pdfjs-${options.version}-dist.zip`;
    const asset = release.assets.find(candidate => candidate.name === assetName);
    if (!asset) {
        throw new Error(`Release ${tag} does not contain ${assetName}.`);
    }
    const releaseDigest = asset.digest?.startsWith('sha256:')
        ? normalizeSha256(asset.digest.slice('sha256:'.length))
        : undefined;
    if (releaseDigest && options.sha256 && releaseDigest !== options.sha256) {
        throw new Error('The supplied SHA-256 does not match the GitHub release asset digest.');
    }
    const expectedSha256 = releaseDigest ?? options.sha256;
    if (!expectedSha256) {
        throw new Error('GitHub did not publish a SHA-256 digest; rerun with --sha256 <digest>.');
    }

    await mkdir(vendorRoot, { recursive: true });
    const stagingPath = await mkdtemp(join(vendorRoot, '.pdfjs-update-'));
    let completed = false;
    try {
        const archivePath = join(stagingPath, assetName);
        await downloadAsset(asset, archivePath, expectedSha256);
        const extractedPath = join(stagingPath, 'extracted');
        await mkdir(extractedPath);
        await extractArchive(archivePath, extractedPath);
        const distributionRoot = await findDistributionRoot(extractedPath);
        const candidateLibrary = join(stagingPath, 'candidate-lib');
        const metadata: VendorMetadata = {
            ...current,
            version: options.version,
            tag,
            asset: assetName,
            releaseUrl: release.url,
            sha256: expectedSha256,
        };
        await copyDistribution(distributionRoot, candidateLibrary, metadata);
        await cp(join(libraryPath, 'pdf.css'), join(candidateLibrary, 'pdf.css'));
        await verifyVendorTree(candidateLibrary, metadata);

        const nextMetadataPath = join(stagingPath, 'vendor.json');
        const nextMarkdownPath = join(stagingPath, 'VENDOR.md');
        await writeFile(nextMetadataPath, `${JSON.stringify(metadata, null, 4)}\n`, 'utf8');
        await writeFile(nextMarkdownPath, renderVendorMarkdown(metadata), 'utf8');
        await applyStagedUpdate(candidateLibrary, nextMetadataPath, nextMarkdownPath, stagingPath);
        completed = true;
        console.log(`[pdfjs] Updated bundled PDF.js ${current.version} -> ${metadata.version}.`);
        console.log('[pdfjs] Run npm run check, npm test, and the manual PDF smoke checklist before committing.');
    } finally {
        if (completed) {
            await rm(stagingPath, { recursive: true, force: true });
        } else {
            console.error(`[pdfjs] Update failed; staging was preserved at ${stagingPath}`);
        }
    }
}

async function fetchRelease(path: string): Promise<Release> {
    const response = await fetch(`https://api.github.com/repos/mozilla/pdf.js/releases/${path}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'academic-pdf-viewer-pdfjs-updater',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub release request failed (${response.status} ${response.statusText}).`);
    }
    return parseRelease(await response.json());
}

function parseRelease(value: unknown): Release {
    if (!isRecord(value)
        || typeof value.tag_name !== 'string'
        || typeof value.html_url !== 'string'
        || !Array.isArray(value.assets)) {
        throw new Error('GitHub returned an invalid release response.');
    }
    return {
        tag: value.tag_name,
        url: value.html_url,
        assets: value.assets.map(parseReleaseAsset),
    };
}

function parseReleaseAsset(value: unknown): ReleaseAsset {
    if (!isRecord(value)
        || typeof value.name !== 'string'
        || typeof value.browser_download_url !== 'string'
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)) {
        throw new Error('GitHub returned an invalid release asset.');
    }
    return {
        name: value.name,
        downloadUrl: value.browser_download_url,
        size: value.size,
        digest: typeof value.digest === 'string' ? value.digest : undefined,
    };
}

async function downloadAsset(asset: ReleaseAsset, targetPath: string, expectedSha256: string): Promise<void> {
    if (asset.size <= 0 || asset.size > maximumArchiveBytes) {
        throw new Error(`Refusing unexpected PDF.js archive size: ${asset.size} bytes.`);
    }
    console.log(`[pdfjs] Downloading ${asset.name} (${asset.size} bytes)...`);
    const response = await fetch(asset.downloadUrl, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`PDF.js archive download failed (${response.status} ${response.statusText}).`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength !== asset.size) {
        throw new Error(`Downloaded ${data.byteLength} bytes; expected ${asset.size}.`);
    }
    const actualSha256 = createHash('sha256').update(data).digest('hex');
    if (actualSha256 !== expectedSha256) {
        throw new Error(`PDF.js archive SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}.`);
    }
    await writeFile(targetPath, data);
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
    try {
        await runFile('tar', ['-xf', archivePath, '-C', destination], { windowsHide: true });
    } catch (error) {
        throw new Error(`Could not extract the PDF.js archive with tar: ${getErrorMessage(error)}`);
    }
}

async function findDistributionRoot(searchRoot: string): Promise<string> {
    const queue = [searchRoot];
    while (queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate) {
            break;
        }
        if (await pathExists(join(candidate, 'build', 'pdf.mjs'))
            && await pathExists(join(candidate, 'web', 'viewer.html'))) {
            return candidate;
        }
        const depth = relative(searchRoot, candidate).split(sep).filter(Boolean).length;
        if (depth >= 3) {
            continue;
        }
        for (const entry of await readdir(candidate, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                queue.push(join(candidate, entry.name));
            }
        }
    }
    throw new Error('The archive does not contain a PDF.js generic distribution.');
}

async function copyDistribution(sourceRoot: string, targetRoot: string, metadata: VendorMetadata): Promise<void> {
    const filter = (source: string): boolean => {
        const relativePath = toPortablePath(relative(sourceRoot, source));
        if (!relativePath) {
            return true;
        }
        if (metadata.excludeSourceMaps && relativePath.endsWith('.map')) {
            return false;
        }
        return !metadata.excludedPaths.includes(relativePath);
    };
    await cp(join(sourceRoot, 'build'), join(targetRoot, 'build'), { recursive: true, filter });
    await cp(join(sourceRoot, 'web'), join(targetRoot, 'web'), { recursive: true, filter });
    await cp(join(sourceRoot, 'LICENSE'), join(targetRoot, 'LICENSE'));
}

async function verifyInstalledVendor(): Promise<VendorMetadata> {
    const metadata = parseMetadata(JSON.parse(await readFile(metadataPath, 'utf8')) as unknown);
    await verifyVendorTree(libraryPath, metadata);
    const markdown = await readFile(vendorMarkdownPath, 'utf8');
    if (!markdown.includes(metadata.version) || !markdown.includes(metadata.sha256)) {
        throw new Error('VENDOR.md does not match vendor.json.');
    }
    return metadata;
}

async function verifyVendorTree(root: string, metadata: VendorMetadata): Promise<void> {
    parseMetadata(metadata);
    for (const path of requiredFiles) {
        const info = await stat(join(root, path)).catch(() => undefined);
        if (!info?.isFile()) {
            throw new Error(`Missing required PDF.js file: ${path}`);
        }
    }
    for (const path of requiredDirectories) {
        const directory = join(root, path);
        const info = await stat(directory).catch(() => undefined);
        if (!info?.isDirectory() || (await readdir(directory)).length === 0) {
            throw new Error(`Missing or empty PDF.js directory: ${path}`);
        }
    }
    for (const path of metadata.excludedPaths) {
        if (await pathExists(join(root, path))) {
            throw new Error(`Excluded PDF.js asset is present: ${path}`);
        }
    }
    if (metadata.excludeSourceMaps) {
        const sourceMap = (await listFiles(root)).find(path => path.endsWith('.map'));
        if (sourceMap) {
            throw new Error(`Excluded PDF.js source map is present: ${sourceMap}`);
        }
    }

    const versionFiles = ['build/pdf.mjs', 'build/pdf.worker.mjs', 'web/viewer.mjs'];
    for (const path of versionFiles) {
        const source = await readFile(join(root, path), 'utf8');
        const version = source.match(/pdfjsVersion\s*=\s*([^\s*]+)/)?.[1];
        if (version !== metadata.version) {
            throw new Error(`${path} reports PDF.js ${version ?? '<missing>'}; expected ${metadata.version}.`);
        }
    }
    const viewerHtml = await readFile(join(root, 'web', 'viewer.html'), 'utf8');
    for (const marker of viewerHtmlMarkers) {
        if (!viewerHtml.includes(marker)) {
            throw new Error(`Unsupported viewer.html: missing marker ${marker}`);
        }
    }
}

function parseMetadata(value: unknown): VendorMetadata {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || typeof value.version !== 'string'
        || !versionPattern.test(value.version)
        || value.tag !== `v${value.version}`
        || value.asset !== `pdfjs-${value.version}-dist.zip`
        || typeof value.releaseUrl !== 'string'
        || !value.releaseUrl.startsWith('https://github.com/mozilla/pdf.js/releases/tag/')
        || typeof value.sha256 !== 'string'
        || !sha256Pattern.test(value.sha256)
        || typeof value.excludeSourceMaps !== 'boolean'
        || !Array.isArray(value.excludedPaths)
        || !value.excludedPaths.every(path => typeof path === 'string' && isSafeVendorRelativePath(path))) {
        throw new Error('assets/pdfviewer/vendor.json is invalid.');
    }
    return value as unknown as VendorMetadata;
}

async function applyStagedUpdate(
    candidateLibrary: string,
    nextMetadataPath: string,
    nextMarkdownPath: string,
    stagingPath: string,
): Promise<void> {
    const swaps = [
        { current: libraryPath, next: candidateLibrary, backup: join(stagingPath, 'previous-lib') },
        { current: metadataPath, next: nextMetadataPath, backup: join(stagingPath, 'previous-vendor.json') },
        { current: vendorMarkdownPath, next: nextMarkdownPath, backup: join(stagingPath, 'previous-VENDOR.md') },
    ];
    const completed: typeof swaps = [];
    try {
        for (const swap of swaps) {
            await rename(swap.current, swap.backup);
            try {
                await rename(swap.next, swap.current);
            } catch (error) {
                await rename(swap.backup, swap.current);
                throw error;
            }
            completed.push(swap);
        }
    } catch (error) {
        for (const swap of completed.reverse()) {
            await rm(swap.current, { recursive: true, force: true });
            await rename(swap.backup, swap.current);
        }
        throw new Error(`Could not apply the staged PDF.js update: ${getErrorMessage(error)}`);
    }
}

function renderVendorMarkdown(metadata: VendorMetadata): string {
    const exclusions = metadata.excludedPaths.map(path => `- \`${path}\``).join('\n');
    return `# PDF.js vendor

The runtime files under \`lib/build\` and \`lib/web\` come from the official PDF.js
${metadata.version} generic distribution:

- Release: <${metadata.releaseUrl}>
- Archive: \`${metadata.asset}\`
- SHA-256: \`${metadata.sha256}\`

\`lib/pdf.css\` is an extension-owned integration file and is not part of the
upstream archive. Source maps and these unused scripting/debug assets are omitted:

${exclusions}

Use the independent \`npm run pdfjs:check\`, \`npm run pdfjs:update\`, and
\`npm run pdfjs:verify\` commands to maintain this bundle.
`;
}

async function listFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
        const directory = queue.pop();
        if (!directory) {
            break;
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolutePath = join(directory, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
            } else if (entry.isFile()) {
                files.push(toPortablePath(relative(root, absolutePath)));
            }
        }
    }
    return files;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function normalizeSha256(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!sha256Pattern.test(normalized)) {
        throw new Error('SHA-256 must contain exactly 64 hexadecimal characters.');
    }
    return normalized;
}

function toPortablePath(path: string): string {
    return path.split(sep).join('/');
}

function isSafeVendorRelativePath(path: string): boolean {
    return path.length > 0
        && !path.startsWith('/')
        && !path.includes('\\')
        && !path.includes(':')
        && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

main().catch(error => {
    console.error(`[pdfjs] ${getErrorMessage(error)}`);
    process.exitCode = 1;
});
