const colorDeltaThreshold = 60;
const minimumChangedPixelsPerRegion = 3;
const maximumRunsPerPage = 20000;
const maximumComponentsToMerge = 1000;
export const maximumRegionsPerPage = 200;
const horizontalMergeDistance = 6;
const verticalMergeDistance = 3;
const regionPadding = 2;
export function compareRasters(original, modified) {
    if (original.width !== modified.width || original.height !== modified.height) {
        return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
    }
    const components = [];
    let previousRuns = [];
    let changedPixels = 0;
    let totalRuns = 0;
    for (let y = 0; y < modified.height; y += 1) {
        const currentRuns = collectChangedRuns(original, modified, y);
        changedPixels += currentRuns.reduce((sum, run) => sum + run.changedPixels, 0);
        totalRuns += currentRuns.length;
        if (totalRuns > maximumRunsPerPage) {
            return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
        }
        connectRuns(currentRuns, previousRuns, y, components);
        previousRuns = currentRuns;
    }
    if (changedPixels === 0) {
        return { regions: [], changedPixels, strategy: "raster" };
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
        return { regions: [], changedPixels, strategy: "raster" };
    }
    pixelRegions = pixelRegions.length <= maximumComponentsToMerge
        ? mergeNearbyRegions(pixelRegions)
        : [boundingPixelRegion(pixelRegions)];
    if (pixelRegions.length > maximumRegionsPerPage) {
        pixelRegions = [boundingPixelRegion(pixelRegions)];
    }
    return {
        regions: pixelRegions.map(region => toNormalizedRegion(region, modified.width, modified.height)),
        changedPixels,
        strategy: "raster"
    };
}
export function mergeNearbyRegions(regions) {
    const merged = [];
    const sorted = [...regions].sort((first, second) => first.top - second.top || first.left - second.left);
    for (const region of sorted) {
        let current = region;
        let mergedAnother;
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
export function boundingPixelRegion(regions) {
    return regions.reduce((result, region) => unionPixelRegions(result, region));
}
export function toNormalizedRegion(region, pageWidth, pageHeight) {
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
export function fullPageRegion() {
    return { left: 0.01, top: 0.01, width: 0.98, height: 0.98 };
}
function collectChangedRuns(original, modified, row) {
    const runs = [];
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
        }
        else if (runStart >= 0) {
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
function connectRuns(currentRuns, previousRuns, row, components) {
    let firstPrevious = 0;
    for (const run of currentRuns) {
        while (firstPrevious < previousRuns.length
            && previousRuns[firstPrevious].right < run.left) {
            firstPrevious += 1;
        }
        let component = -1;
        for (let index = firstPrevious; index < previousRuns.length && previousRuns[index].left <= run.right; index += 1) {
            const previousComponent = findComponent(components, previousRuns[index].component);
            component = component < 0
                ? previousComponent
                : unionComponents(components, component, previousComponent);
        }
        if (component < 0) {
            component = createComponent(components, run, row);
        }
        else {
            addRunToComponent(components, component, run, row);
        }
        run.component = findComponent(components, component);
    }
}
function createComponent(components, run, row) {
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
function addRunToComponent(components, component, run, row) {
    const root = findComponent(components, component);
    const region = components[root];
    region.left = Math.min(region.left, run.left);
    region.top = Math.min(region.top, row);
    region.right = Math.max(region.right, run.right);
    region.bottom = Math.max(region.bottom, row + 1);
    region.changedPixels += run.changedPixels;
}
function findComponent(components, component) {
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
function unionComponents(components, first, second) {
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
function shouldMergeRegions(first, second) {
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
function intervalGap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstEnd, secondEnd));
}
function intervalOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}
function unionPixelRegions(first, second) {
    return {
        left: Math.min(first.left, second.left),
        top: Math.min(first.top, second.top),
        right: Math.max(first.right, second.right),
        bottom: Math.max(first.bottom, second.bottom),
        changedPixels: first.changedPixels + second.changedPixels
    };
}
