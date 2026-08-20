export interface ScheduledPageComparison {
    pageNumber: number;
    generation: number;
}

export class PageComparisonScheduler {
    private generation = 0;
    private activeComparisons = 0;
    private readonly queuedPages = new Map<number, number>();
    private readonly maximumConcurrentComparisons: number;
    private readonly maximumQueuedPages: number;

    constructor(
        maximumConcurrentComparisons: number,
        maximumQueuedPages: number
    ) {
        this.maximumConcurrentComparisons = maximumConcurrentComparisons;
        this.maximumQueuedPages = maximumQueuedPages;
    }

    get activeCount(): number {
        return this.activeComparisons;
    }

    get queuedCount(): number {
        return this.queuedPages.size;
    }

    get atCapacity(): boolean {
        return this.activeComparisons >= this.maximumConcurrentComparisons;
    }

    invalidate(): void {
        this.generation += 1;
        this.queuedPages.clear();
    }

    enqueue(pageNumber: number): void {
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

    removeQueued(pageNumber: number): void {
        this.queuedPages.delete(pageNumber);
    }

    startNext(): ScheduledPageComparison | undefined {
        if (this.atCapacity) {
            return undefined;
        }
        while (this.queuedPages.size > 0) {
            const next = this.queuedPages.entries().next().value as [number, number] | undefined;
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

    startImmediately(pageNumber: number): ScheduledPageComparison | undefined {
        if (this.atCapacity) {
            return undefined;
        }
        this.removeQueued(pageNumber);
        this.activeComparisons += 1;
        return { pageNumber, generation: this.generation };
    }

    complete(): void {
        if (this.activeComparisons > 0) {
            this.activeComparisons -= 1;
        }
    }

    isCurrent(generation: number): boolean {
        return generation === this.generation;
    }
}
