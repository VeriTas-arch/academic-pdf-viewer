"use strict";

window.__academicTestMessages = [];
window.__academicPrintCalls = 0;
window.acquireVsCodeApi = () => ({
    postMessage(message) {
        window.__academicTestMessages.push(message);
        window.dispatchEvent(new CustomEvent("academic-test-message", { detail: message }));
    },
    getState() {
        return undefined;
    },
    setState() {
        return undefined;
    }
});
window.print = () => {
    window.__academicPrintCalls++;
};
