"use strict";

window.__academicTestMessages = [];
window.__academicTestDebug = [];
window.__academicPrintCalls = 0;
window.acquireVsCodeApi = () => ({
    postMessage(message) {
        window.__academicTestMessages.push(message);
    },
    getState() {
        return undefined;
    },
    setState() {
        return undefined;
    }
});
window.addEventListener("academic-pdf-debug", event => {
    window.__academicTestDebug.push(event.detail);
});
window.print = () => {
    window.__academicPrintCalls++;
};
