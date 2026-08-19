import assert from "node:assert/strict";
import test from "node:test";

import { collectNearbyLinesFromRows } from "../assets/academic/citationPreviewLines.js";

test("collectNearbyLinesFromRows keeps fallback behavior at 40-row cap and 4-line return", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
        text: `token-${index + 1}`,
        x: index,
        y: 0
    }));

    const lines = collectNearbyLinesFromRows(rows, 10000, {
        textRadiusPx: 10
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("token-40"), true);
    assert.equal(lines[0].includes("token-10"), true);
    assert.equal(lines[0].includes("token-5"), true);
});

test("collectNearbyLinesFromRows does not truncate to first 4 lines when near target", () => {
    const rows = [
        ...Array.from({ length: 6 }, (_, index) => ({ text: `line1-${index + 1}`, x: index, y: 0 })),
        ...Array.from({ length: 6 }, (_, index) => ({ text: `line2-${index + 1}`, x: index, y: 10 }))
    ];
    const lines = collectNearbyLinesFromRows(rows, 0, {
        textRadiusPx: 100
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "line1-1 line1-2 line1-3 line1-4 line1-5 line1-6");
    assert.equal(lines[1], "line2-1 line2-2 line2-3 line2-4 line2-5 line2-6");
});
