export interface RasterPage {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}

export interface DiffRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type DiffChangeKind = "insert" | "delete" | "replace";
export type DiffStrategy = "page" | "raster" | "text";

export interface PageDiffChange {
    id: string;
    kind: DiffChangeKind;
    originalRegions: DiffRegion[];
    modifiedRegions: DiffRegion[];
    strategy: DiffStrategy;
}

export interface PageDiffResult {
    changes: PageDiffChange[];
    originalRegions: DiffRegion[];
    modifiedRegions: DiffRegion[];
    changedPixels: number;
    strategy: DiffStrategy;
}

export function nextDiffRegionIndex(
    regionCount: number,
    selectedIndex: number | undefined,
    direction: "next" | "previous"
): number | undefined {
    if (regionCount < 1) {
        return undefined;
    }
    if (selectedIndex === undefined) {
        return direction === "next" ? 0 : regionCount - 1;
    }
    const index = direction === "next" ? selectedIndex + 1 : selectedIndex - 1;
    return index >= 0 && index < regionCount ? index : undefined;
}

export interface DiffPageNavigationTarget<T> {
    pageNumber: number;
    index: number;
    regions: T[];
}

export async function findNextDiffPage<T>(
    startPage: number,
    lastPage: number,
    direction: "next" | "previous",
    loadRegions: (pageNumber: number) => Promise<T[] | undefined>
): Promise<DiffPageNavigationTarget<T> | undefined> {
    const step = direction === "next" ? 1 : -1;
    for (let pageNumber = startPage;
        pageNumber >= 1 && pageNumber <= lastPage;
        pageNumber += step) {
        const regions = await loadRegions(pageNumber);
        if (regions === undefined) {
            return undefined;
        }
        if (regions.length > 0) {
            return {
                pageNumber,
                index: direction === "next" ? 0 : regions.length - 1,
                regions
            };
        }
    }
    return undefined;
}

export interface PixelRegion {
    left: number;
    top: number;
    right: number;
    bottom: number;
    changedPixels: number;
}

export interface TextToken extends PixelRegion {
    text: string;
}

export interface TextDiffChangeSide {
    regions: PixelRegion[];
}

export interface TextDiffChange {
    id: string;
    kind: DiffChangeKind;
    original?: TextDiffChangeSide;
    modified?: TextDiffChangeSide;
    strategy: "text";
}

interface TextTokenMatch {
    original: number;
    modified: number;
}

interface DifferenceRun {
    left: number;
    right: number;
    changedPixels: number;
    component: number;
}

interface DifferenceComponent extends PixelRegion {
    parent: number;
}

const colorDeltaThreshold = 60;
const minimumChangedPixelsPerRegion = 3;
const maximumRunsPerPage = 20000;
const maximumComponentsToMerge = 1000;
export const maximumRegionsPerPage = 200;
const horizontalMergeDistance = 6;
const verticalMergeDistance = 3;
const regionPadding = 2;
const minimumTextMatchRatio = 0.5;
const maximumTextTokensPerPage = 1500;
const minimumSameLineHeightRatio = 0.6;
const minimumPairedRegionHeightRatio = 0.6;

export function compareRasters(original: RasterPage, modified: RasterPage): PageDiffResult {
    if (original.width !== modified.width || original.height !== modified.height) {
        return symmetricResult([fullPageRegion()], -1, "page");
    }

    const components: DifferenceComponent[] = [];
    let previousRuns: DifferenceRun[] = [];
    let changedPixels = 0;
    let totalRuns = 0;
    for (let y = 0; y < modified.height; y += 1) {
        const currentRuns = collectChangedRuns(original, modified, y);
        changedPixels += currentRuns.reduce((sum, run) => sum + run.changedPixels, 0);
        totalRuns += currentRuns.length;
        if (totalRuns > maximumRunsPerPage) {
            return symmetricResult([fullPageRegion()], -1, "page");
        }
        connectRuns(currentRuns, previousRuns, y, components);
        previousRuns = currentRuns;
    }

    if (changedPixels === 0) {
        return symmetricResult([], changedPixels, "raster");
    }

    let pixelRegions = components
        .filter((component, index) => findComponent(components, index) === index
            && component.changedPixels >= minimumChangedPixelsPerRegion)
        .map(component => ({
            left: component.left,
            top: component.top,
            right: component.right,
            bottom: component.bottom,
            changedPixels: component.changedPixels
        }));
    if (pixelRegions.length === 0) {
        return symmetricResult([], changedPixels, "raster");
    }

    pixelRegions = pixelRegions.length <= maximumComponentsToMerge
        ? mergeNearbyRegions(pixelRegions)
        : [boundingPixelRegion(pixelRegions)];
    if (pixelRegions.length > maximumRegionsPerPage) {
        pixelRegions = [boundingPixelRegion(pixelRegions)];
    }
    const regions = pixelRegions.map(region => toNormalizedRegion(
        region,
        modified.width,
        modified.height
    ));
    return symmetricResult(regions, changedPixels, "raster");
}

export function compareTextTokens(
    original: TextToken[],
    modified: TextToken[],
    originalPageWidth: number,
    originalPageHeight: number,
    modifiedPageWidth: number,
    modifiedPageHeight: number
): PageDiffResult | null {
    const changes = compareTextTokenChanges(original, modified);
    if (!changes) {
        return null;
    }

    return textResult(
        changes,
        originalPageWidth,
        originalPageHeight,
        modifiedPageWidth,
        modifiedPageHeight
    );
}

export function compareTextTokenChanges(
    original: TextToken[],
    modified: TextToken[]
): TextDiffChange[] | null {
    if (original.length > maximumTextTokensPerPage
        || modified.length > maximumTextTokensPerPage
        || original.length === 0 && modified.length === 0
        || textTokensEqual(original, modified)) {
        return null;
    }

    if (original.length === 0) {
        return [createTextChange(0, [], modified)];
    }
    if (modified.length === 0) {
        return [createTextChange(0, original, [])];
    }

    const matches = findTextTokenMatches(original, modified);
    if (matches.length / Math.min(original.length, modified.length) < minimumTextMatchRatio) {
        return null;
    }

    return collectTextChanges(original, modified, matches);
}

function textResult(
    changes: TextDiffChange[],
    originalPageWidth: number,
    originalPageHeight: number,
    modifiedPageWidth: number,
    modifiedPageHeight: number
): PageDiffResult {
    const synchronizedChanges = synchronizePairedTextChangeHeights(
        changes,
        originalPageWidth,
        originalPageHeight,
        modifiedPageWidth,
        modifiedPageHeight
    );
    let normalizedChanges = normalizeTextChanges(
        synchronizedChanges,
        originalPageWidth,
        originalPageHeight,
        modifiedPageWidth,
        modifiedPageHeight
    );
    let originalRegions = normalizedChanges.flatMap(change => change.originalRegions);
    let modifiedRegions = normalizedChanges.flatMap(change => change.modifiedRegions);
    if (originalRegions.length > maximumRegionsPerPage
        || modifiedRegions.length > maximumRegionsPerPage) {
        originalRegions = normalizeTextRegions(
            synchronizedChanges.flatMap(change => change.original?.regions ?? []),
            originalPageWidth,
            originalPageHeight
        );
        modifiedRegions = normalizeTextRegions(
            synchronizedChanges.flatMap(change => change.modified?.regions ?? []),
            modifiedPageWidth,
            modifiedPageHeight
        );
        normalizedChanges = [{
            id: "text-overflow",
            kind: originalRegions.length === 0 ? "insert" : modifiedRegions.length === 0 ? "delete" : "replace",
            originalRegions,
            modifiedRegions,
            strategy: "text"
        }];
    }
    return {
        changes: normalizedChanges,
        originalRegions,
        modifiedRegions,
        changedPixels: -1,
        strategy: "text"
    };
}

interface TaggedPixelRegion extends PixelRegion {
    changeId: string;
}

function normalizeTextChanges(
    changes: TextDiffChange[],
    originalPageWidth: number,
    originalPageHeight: number,
    modifiedPageWidth: number,
    modifiedPageHeight: number
): PageDiffChange[] {
    const original = normalizeTaggedTextRegions(changes, "original", originalPageWidth, originalPageHeight);
    const modified = normalizeTaggedTextRegions(changes, "modified", modifiedPageWidth, modifiedPageHeight);
    return changes.map(change => synchronizeNormalizedChangeHeights({
        id: change.id,
        kind: change.kind,
        originalRegions: original.get(change.id) ?? [],
        modifiedRegions: modified.get(change.id) ?? [],
        strategy: "text"
    }, originalPageWidth, originalPageHeight, modifiedPageWidth, modifiedPageHeight));
}

function synchronizeNormalizedChangeHeights(
    change: PageDiffChange,
    originalPageWidth: number,
    originalPageHeight: number,
    modifiedPageWidth: number,
    modifiedPageHeight: number
): PageDiffChange {
    if (change.kind !== "replace"
        || change.originalRegions.length === 0
        || change.originalRegions.length !== change.modifiedRegions.length
        || Math.abs(originalPageWidth - modifiedPageWidth) > 0.5
        || Math.abs(originalPageHeight - modifiedPageHeight) > 0.5) {
        return change;
    }

    const originalRegions = [...change.originalRegions];
    const modifiedRegions = [...change.modifiedRegions];
    for (let index = 0; index < originalRegions.length; index += 1) {
        const originalRegion = originalRegions[index];
        const modifiedRegion = modifiedRegions[index];
        const originalHeight = originalRegion.height * originalPageHeight;
        const modifiedHeight = modifiedRegion.height * modifiedPageHeight;
        const minimumHeight = Math.min(originalHeight, modifiedHeight);
        const maximumHeight = Math.max(originalHeight, modifiedHeight);
        const originalCenter = (originalRegion.top + originalRegion.height / 2) * originalPageHeight;
        const modifiedCenter = (modifiedRegion.top + modifiedRegion.height / 2) * modifiedPageHeight;
        if (Math.abs(originalHeight - modifiedHeight) < 0.000001
            || minimumHeight <= 0
            || minimumHeight / maximumHeight < minimumPairedRegionHeightRatio
            || Math.abs(originalCenter - modifiedCenter) > maximumHeight) {
            continue;
        }
        originalRegions[index] = resizeNormalizedRegionHeight(
            originalRegion,
            originalPageHeight,
            maximumHeight
        );
        modifiedRegions[index] = resizeNormalizedRegionHeight(
            modifiedRegion,
            modifiedPageHeight,
            maximumHeight
        );
    }
    return { ...change, originalRegions, modifiedRegions };
}

function resizeNormalizedRegionHeight(
    region: DiffRegion,
    pageHeight: number,
    pixelHeight: number
): DiffRegion {
    const height = Math.min(1, pixelHeight / pageHeight);
    const center = region.top + region.height / 2;
    return {
        ...region,
        top: Math.max(0, Math.min(1 - height, center - height / 2)),
        height
    };
}

function normalizeTaggedTextRegions(
    changes: TextDiffChange[],
    side: "original" | "modified",
    pageWidth: number,
    pageHeight: number
): Map<string, DiffRegion[]> {
    const tagged = changes.flatMap(change => prepareTextRegions(change[side]?.regions ?? [])
        .map(region => ({ ...region, changeId: change.id })));
    const aligned = alignSameLineRegionHeights(tagged) as TaggedPixelRegion[];
    const result = new Map<string, DiffRegion[]>();
    for (const region of aligned) {
        const regions = result.get(region.changeId) ?? [];
        regions.push(toNormalizedRegion(region, pageWidth, pageHeight));
        result.set(region.changeId, regions);
    }
    return result;
}

function synchronizePairedTextChangeHeights(
    changes: TextDiffChange[],
    originalPageWidth: number,
    originalPageHeight: number,
    modifiedPageWidth: number,
    modifiedPageHeight: number
): TextDiffChange[] {
    if (Math.abs(originalPageWidth - modifiedPageWidth) > 0.5
        || Math.abs(originalPageHeight - modifiedPageHeight) > 0.5) {
        return changes;
    }

    return changes.map(change => {
        if (change.kind !== "replace" || !change.original || !change.modified) {
            return change;
        }
        const original = prepareTextRegions(change.original.regions);
        const modified = prepareTextRegions(change.modified.regions);
        if (original.length !== modified.length) {
            return change;
        }

        const synchronizedOriginal = [...original];
        const synchronizedModified = [...modified];
        for (let index = 0; index < original.length; index += 1) {
            const originalRegion = original[index];
            const modifiedRegion = modified[index];
            const originalHeight = originalRegion.bottom - originalRegion.top;
            const modifiedHeight = modifiedRegion.bottom - modifiedRegion.top;
            const minimumHeight = Math.min(originalHeight, modifiedHeight);
            const maximumHeight = Math.max(originalHeight, modifiedHeight);
            const originalCenter = (originalRegion.top + originalRegion.bottom) / 2;
            const modifiedCenter = (modifiedRegion.top + modifiedRegion.bottom) / 2;
            if (Math.abs(originalHeight - modifiedHeight) < 0.000001) {
                continue;
            }
            if (minimumHeight <= 0
                || minimumHeight / maximumHeight < minimumPairedRegionHeightRatio
                || Math.abs(originalCenter - modifiedCenter) > maximumHeight) {
                continue;
            }

            synchronizedOriginal[index] = resizePixelRegionHeight(
                originalRegion,
                maximumHeight
            );
            synchronizedModified[index] = resizePixelRegionHeight(
                modifiedRegion,
                maximumHeight
            );
        }
        return {
            ...change,
            original: { regions: synchronizedOriginal },
            modified: { regions: synchronizedModified }
        };
    });
}

function resizePixelRegionHeight(region: PixelRegion, pixelHeight: number): PixelRegion {
    const center = (region.top + region.bottom) / 2;
    return {
        ...region,
        top: center - pixelHeight / 2,
        bottom: center + pixelHeight / 2
    };
}

function symmetricResult(
    regions: DiffRegion[],
    changedPixels: number,
    strategy: "page" | "raster"
): PageDiffResult {
    const changes = regions.map((region, index) => ({
        id: `${strategy}-${index + 1}`,
        kind: "replace" as const,
        originalRegions: [region],
        modifiedRegions: [region],
        strategy
    }));
    return {
        changes,
        originalRegions: regions,
        modifiedRegions: regions,
        changedPixels,
        strategy
    };
}

function textTokensEqual(original: TextToken[], modified: TextToken[]): boolean {
    return original.length === modified.length
        && original.every((token, index) => token.text === modified[index].text);
}

function findTextTokenMatches(original: TextToken[], modified: TextToken[]): TextTokenMatch[] {
    let prefixLength = 0;
    const maxPrefixLength = Math.min(original.length, modified.length);
    while (prefixLength < maxPrefixLength
        && original[prefixLength].text === modified[prefixLength].text) {
        prefixLength += 1;
    }

    let originalSuffixLength = original.length;
    let modifiedSuffixLength = modified.length;
    while (originalSuffixLength > prefixLength
        && modifiedSuffixLength > prefixLength
        && original[originalSuffixLength - 1].text === modified[modifiedSuffixLength - 1].text) {
        originalSuffixLength -= 1;
        modifiedSuffixLength -= 1;
    }

    const trimmedOriginalLength = originalSuffixLength - prefixLength;
    const trimmedModifiedLength = modifiedSuffixLength - prefixLength;
    const lengths = Array.from(
        { length: trimmedOriginalLength + 1 },
        () => new Uint16Array(trimmedModifiedLength + 1)
    );
    for (let originalIndex = 1; originalIndex <= trimmedOriginalLength; originalIndex += 1) {
        for (let modifiedIndex = 1; modifiedIndex <= trimmedModifiedLength; modifiedIndex += 1) {
            const originalToken = original[prefixLength + originalIndex - 1];
            const modifiedToken = modified[prefixLength + modifiedIndex - 1];
            lengths[originalIndex][modifiedIndex] = originalToken.text === modifiedToken.text
                ? lengths[originalIndex - 1][modifiedIndex - 1] + 1
                : Math.max(
                    lengths[originalIndex - 1][modifiedIndex],
                    lengths[originalIndex][modifiedIndex - 1]
                );
        }
    }

    const matches: TextTokenMatch[] = [];
    for (let index = 0; index < prefixLength; index += 1) {
        matches.push({ original: index, modified: index });
    }

    const middleMatches: TextTokenMatch[] = [];
    let originalIndex = trimmedOriginalLength;
    let modifiedIndex = trimmedModifiedLength;
    while (originalIndex > 0 && modifiedIndex > 0) {
        const originalToken = original[prefixLength + originalIndex - 1];
        const modifiedToken = modified[prefixLength + modifiedIndex - 1];
        if (originalToken.text === modifiedToken.text) {
            middleMatches.push({
                original: prefixLength + originalIndex - 1,
                modified: prefixLength + modifiedIndex - 1,
            });
            originalIndex -= 1;
            modifiedIndex -= 1;
        } else if (lengths[originalIndex - 1][modifiedIndex]
            >= lengths[originalIndex][modifiedIndex - 1]) {
            originalIndex -= 1;
        } else {
            modifiedIndex -= 1;
        }
    }

    for (let index = middleMatches.length - 1; index >= 0; index -= 1) {
        matches.push(middleMatches[index]);
    }
    const suffixMatchCount = original.length - originalSuffixLength;
    for (let index = 0; index < suffixMatchCount; index += 1) {
        matches.push({
            original: originalSuffixLength + index,
            modified: modifiedSuffixLength + index,
        });
    }

    return matches;
}

function collectTextChanges(
    original: TextToken[],
    modified: TextToken[],
    matches: TextTokenMatch[]
): TextDiffChange[] {
    const changes: TextDiffChange[] = [];
    let originalStart = 0;
    let modifiedStart = 0;
    for (let index = 0; index <= matches.length; index += 1) {
        const match = matches[index];
        const originalEnd = match?.original ?? original.length;
        const modifiedEnd = match?.modified ?? modified.length;
        const originalRegions = original.slice(originalStart, originalEnd);
        const modifiedRegions = modified.slice(modifiedStart, modifiedEnd);
        if (originalRegions.length > 0 || modifiedRegions.length > 0) {
            changes.push(createTextChange(changes.length, originalRegions, modifiedRegions));
        }
        if (match) {
            originalStart = match.original + 1;
            modifiedStart = match.modified + 1;
        }
    }
    return changes;
}

function createTextChange(
    index: number,
    originalRegions: PixelRegion[],
    modifiedRegions: PixelRegion[]
): TextDiffChange {
    return {
        id: `text-${index + 1}`,
        kind: originalRegions.length === 0
            ? "insert"
            : modifiedRegions.length === 0
                ? "delete"
                : "replace",
        ...(originalRegions.length > 0 ? { original: { regions: originalRegions } } : {}),
        ...(modifiedRegions.length > 0 ? { modified: { regions: modifiedRegions } } : {}),
        strategy: "text"
    };
}

function normalizeTextRegions(
    regions: PixelRegion[],
    pageWidth: number,
    pageHeight: number
): DiffRegion[] {
    if (regions.length === 0) {
        return [];
    }

    let merged = prepareTextRegions(regions);
    if (merged.length > maximumRegionsPerPage) {
        merged = [boundingPixelRegion(merged)];
    }
    return merged.map(region => toNormalizedRegion(region, pageWidth, pageHeight));
}

function prepareTextRegions(regions: PixelRegion[]): PixelRegion[] {
    return alignSameLineRegionHeights(mergeNearbyRegions(regions));
}

function alignSameLineRegionHeights(regions: PixelRegion[]): PixelRegion[] {
    const groups: PixelRegion[][] = [];
    for (const region of regions) {
        const group = groups.find(candidate => candidate.some(
            member => regionsShareTextLine(member, region)
        ));
        if (group) {
            group.push(region);
        } else {
            groups.push([region]);
        }
    }

    return groups.flatMap(group => {
        const top = Math.min(...group.map(region => region.top));
        const bottom = Math.max(...group.map(region => region.bottom));
        return group.map(region => ({ ...region, top, bottom }));
    }).sort((first, second) => first.top - second.top || first.left - second.left);
}

function regionsShareTextLine(first: PixelRegion, second: PixelRegion): boolean {
    const firstHeight = first.bottom - first.top;
    const secondHeight = second.bottom - second.top;
    const minimumHeight = Math.min(firstHeight, secondHeight);
    const maximumHeight = Math.max(firstHeight, secondHeight);
    return minimumHeight > 0
        && minimumHeight / maximumHeight >= minimumSameLineHeightRatio
        && intervalOverlap(first.top, first.bottom, second.top, second.bottom)
            >= minimumHeight * minimumSameLineHeightRatio;
}

export function mergeNearbyRegions(regions: PixelRegion[]): PixelRegion[] {
    const merged: PixelRegion[] = [];
    const sorted = [...regions].sort((first, second) => first.top - second.top || first.left - second.left);
    for (const region of sorted) {
        let current = region;
        let mergedAnother: boolean;
        do {
            mergedAnother = false;
            for (let index = 0; index < merged.length; index += 1) {
                if (!shouldMergeRegions(merged[index], current)) {
                    continue;
                }
                current = unionPixelRegions(merged[index], current);
                merged.splice(index, 1);
                mergedAnother = true;
                break;
            }
        } while (mergedAnother);
        merged.push(current);
    }
    return merged.sort((first, second) => first.top - second.top || first.left - second.left);
}

export function boundingPixelRegion(regions: PixelRegion[]): PixelRegion {
    return regions.reduce((result, region) => unionPixelRegions(result, region));
}

export function toNormalizedRegion(region: PixelRegion, pageWidth: number, pageHeight: number): DiffRegion {
    const paddedLeft = Math.max(0, region.left - regionPadding);
    const paddedTop = Math.max(0, region.top - regionPadding);
    const paddedRight = Math.min(pageWidth, region.right + regionPadding);
    const paddedBottom = Math.min(pageHeight, region.bottom + regionPadding);
    return {
        left: paddedLeft / pageWidth,
        top: paddedTop / pageHeight,
        width: (paddedRight - paddedLeft) / pageWidth,
        height: (paddedBottom - paddedTop) / pageHeight
    };
}

export function fullPageRegion(): DiffRegion {
    return { left: 0.01, top: 0.01, width: 0.98, height: 0.98 };
}

function collectChangedRuns(original: RasterPage, modified: RasterPage, row: number): DifferenceRun[] {
    const runs: DifferenceRun[] = [];
    let runStart = -1;
    let runPixels = 0;
    for (let x = 0; x <= modified.width; x += 1) {
        let changed = false;
        if (x < modified.width) {
            const pixel = (row * modified.width + x) * 4;
            const delta = Math.abs(original.pixels[pixel] - modified.pixels[pixel])
                + Math.abs(original.pixels[pixel + 1] - modified.pixels[pixel + 1])
                + Math.abs(original.pixels[pixel + 2] - modified.pixels[pixel + 2]);
            changed = delta > colorDeltaThreshold;
        }

        if (changed) {
            if (runStart < 0) {
                runStart = x;
            }
            runPixels += 1;
        } else if (runStart >= 0) {
            runs.push({
                left: runStart,
                right: x,
                changedPixels: runPixels,
                component: -1
            });
            runStart = -1;
            runPixels = 0;
        }
    }
    return runs;
}

function connectRuns(
    currentRuns: DifferenceRun[],
    previousRuns: DifferenceRun[],
    row: number,
    components: DifferenceComponent[]
): void {
    let firstPrevious = 0;
    for (const run of currentRuns) {
        while (firstPrevious < previousRuns.length
            && previousRuns[firstPrevious].right < run.left) {
            firstPrevious += 1;
        }

        let component = -1;
        for (let index = firstPrevious;
            index < previousRuns.length && previousRuns[index].left <= run.right;
            index += 1) {
            const previousComponent = findComponent(components, previousRuns[index].component);
            component = component < 0
                ? previousComponent
                : unionComponents(components, component, previousComponent);
        }
        if (component < 0) {
            component = createComponent(components, run, row);
        } else {
            addRunToComponent(components, component, run, row);
        }
        run.component = findComponent(components, component);
    }
}

function createComponent(
    components: DifferenceComponent[],
    run: DifferenceRun,
    row: number
): number {
    const index = components.length;
    components.push({
        parent: index,
        left: run.left,
        top: row,
        right: run.right,
        bottom: row + 1,
        changedPixels: run.changedPixels
    });
    return index;
}

function addRunToComponent(
    components: DifferenceComponent[],
    component: number,
    run: DifferenceRun,
    row: number
): void {
    const root = findComponent(components, component);
    const region = components[root];
    region.left = Math.min(region.left, run.left);
    region.top = Math.min(region.top, row);
    region.right = Math.max(region.right, run.right);
    region.bottom = Math.max(region.bottom, row + 1);
    region.changedPixels += run.changedPixels;
}

function findComponent(components: DifferenceComponent[], component: number): number {
    let root = component;
    while (components[root].parent !== root) {
        root = components[root].parent;
    }
    while (components[component].parent !== component) {
        const parent = components[component].parent;
        components[component].parent = root;
        component = parent;
    }
    return root;
}

function unionComponents(
    components: DifferenceComponent[],
    first: number,
    second: number
): number {
    const firstRoot = findComponent(components, first);
    const secondRoot = findComponent(components, second);
    if (firstRoot === secondRoot) {
        return firstRoot;
    }

    const target = components[firstRoot];
    const source = components[secondRoot];
    source.parent = firstRoot;
    target.left = Math.min(target.left, source.left);
    target.top = Math.min(target.top, source.top);
    target.right = Math.max(target.right, source.right);
    target.bottom = Math.max(target.bottom, source.bottom);
    target.changedPixels += source.changedPixels;
    return firstRoot;
}

function shouldMergeRegions(first: PixelRegion, second: PixelRegion): boolean {
    const horizontalGap = intervalGap(first.left, first.right, second.left, second.right);
    const verticalGap = intervalGap(first.top, first.bottom, second.top, second.bottom);
    const verticalOverlap = intervalOverlap(first.top, first.bottom, second.top, second.bottom);
    const horizontalOverlap = intervalOverlap(first.left, first.right, second.left, second.right);
    const minimumHeight = Math.min(first.bottom - first.top, second.bottom - second.top);
    const minimumWidth = Math.min(first.right - first.left, second.right - second.left);
    const sameLine = verticalOverlap >= minimumHeight * 0.6
        && horizontalGap <= horizontalMergeDistance;
    const sameGlyph = horizontalOverlap >= minimumWidth * 0.5
        && verticalGap <= verticalMergeDistance;
    return horizontalGap === 0 && verticalGap === 0 || sameLine || sameGlyph;
}

function intervalGap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): number {
    return Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstEnd, secondEnd));
}

function intervalOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): number {
    return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}

function unionPixelRegions(first: PixelRegion, second: PixelRegion): PixelRegion {
    return {
        left: Math.min(first.left, second.left),
        top: Math.min(first.top, second.top),
        right: Math.max(first.right, second.right),
        bottom: Math.max(first.bottom, second.bottom),
        changedPixels: first.changedPixels + second.changedPixels
    };
}
