export interface PositionedTextRow {
    text: string;
    x: number;
    y: number;
}

export interface CollectNearbyLinesOptions {
    textRadiusPx: number;
    maxCandidateRows?: number;
    maxReturnedLines?: number;
}

export function collectNearbyLinesFromRows(
    rows: ReadonlyArray<PositionedTextRow>,
    targetY: number | null,
    options: CollectNearbyLinesOptions
): string[] {
    const nearbyRows = targetY === null
        ? []
        : rows.filter(row => Math.abs(row.y - targetY) <= options.textRadiusPx);
    const isFallback = targetY !== null && nearbyRows.length === 0;
    const candidateRows = isFallback || targetY === null ? rows : nearbyRows;
    if (candidateRows.length === 0) {
        return [];
    }

    const sortedCandidateRows = [...candidateRows];
    sortedCandidateRows.sort((a, b) => Math.abs(a.y - (targetY ?? a.y)) - Math.abs(b.y - (targetY ?? b.y)) || a.y - b.y || a.x - b.x);
    const selectedRows = sortedCandidateRows.slice(0, options.maxCandidateRows ?? 40);
    selectedRows.sort((a, b) => a.y - b.y || a.x - b.x);

    const lines: Array<{ y: number; parts: PositionedTextRow[] }> = [];
    for (const row of selectedRows) {
        const last = lines[lines.length - 1];
        if (!last || Math.abs(last.y - row.y) > 4) {
            lines.push({ y: row.y, parts: [row] });
        } else {
            last.parts.push(row);
        }
    }

    const renderedLines = lines.map(line => line.parts
        .sort((a, b) => a.x - b.x)
        .map(part => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim())
        .filter(Boolean);

    return isFallback ? renderedLines.slice(0, options.maxReturnedLines ?? 4) : renderedLines;
}
