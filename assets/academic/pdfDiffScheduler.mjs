export class PageComparisonScheduler {
    generation = 0;
    activeComparisons = 0;
    queuedPages = new Set();
    maximumConcurrentComparisons;
    maximumQueuedPages;
    constructor(maximumConcurrentComparisons, maximumQueuedPages) {
        this.maximumConcurrentComparisons = maximumConcurrentComparisons;
        this.maximumQueuedPages = maximumQueuedPages;
    }
    get activeCount() {
        return this.activeComparisons;
    }
    get queuedCount() {
        return this.queuedPages.size;
    }
    get atCapacity() {
        return this.activeComparisons >= this.maximumConcurrentComparisons;
    }
    invalidate() {
        this.generation += 1;
        this.queuedPages.clear();
    }
    enqueue(pageNumber) {
        this.queuedPages.delete(pageNumber);
        this.queuedPages.add(pageNumber);
        while (this.queuedPages.size > this.maximumQueuedPages) {
            const oldestPage = this.queuedPages.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            this.queuedPages.delete(oldestPage);
        }
    }
    removeQueued(pageNumber) {
        this.queuedPages.delete(pageNumber);
    }
    startNext() {
        if (this.atCapacity) {
            return undefined;
        }
        const pageNumber = this.queuedPages.values().next().value;
        if (pageNumber === undefined) {
            return undefined;
        }
        return this.startImmediately(pageNumber);
    }
    startImmediately(pageNumber) {
        if (this.atCapacity) {
            return undefined;
        }
        this.removeQueued(pageNumber);
        this.activeComparisons += 1;
        return { pageNumber, generation: this.generation };
    }
    complete() {
        if (this.activeComparisons > 0) {
            this.activeComparisons -= 1;
        }
    }
    isCurrent(generation) {
        return generation === this.generation;
    }
}
