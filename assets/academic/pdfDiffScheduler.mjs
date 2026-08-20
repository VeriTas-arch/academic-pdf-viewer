export class PageComparisonScheduler {
    generation = 0;
    activeComparisons = 0;
    queuedPages = new Map();
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
        this.queuedPages.set(pageNumber, this.generation);
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
        while (this.queuedPages.size > 0) {
            const next = this.queuedPages.entries().next().value;
            if (!next) {
                return undefined;
            }
            const [pageNumber, generation] = next;
            this.queuedPages.delete(pageNumber);
            if (generation !== this.generation) {
                continue;
            }
            this.activeComparisons += 1;
            return { pageNumber, generation };
        }
        return undefined;
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
