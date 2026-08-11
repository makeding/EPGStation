import * as stream from 'stream';

/**
 * A non-blocking, bounded input queue for an optional child process.
 *
 * The producer is never paused. If the child cannot keep up and the queue
 * reaches its limit, only the optional process is failed.
 */
export default class BoundedProcessInput {
    private readonly input: stream.Writable;
    private readonly maxBufferSize: number;
    private readonly onFailure: (error: Error) => void;
    private readonly queue: Buffer[] = [];
    private queuedBytes = 0;
    private isBackpressured = false;
    private isEndRequested = false;
    private isFinished = false;

    constructor(input: stream.Writable, maxBufferSize: number, onFailure: (error: Error) => void) {
        this.input = input;
        this.maxBufferSize = maxBufferSize;
        this.onFailure = onFailure;
        this.input.on('drain', this.onDrain);
        this.input.on('error', this.onInputError);
    }

    public write(chunk: Buffer): void {
        if (this.isFinished === true || this.isEndRequested === true) {
            return;
        }

        if (this.isBackpressured === false && this.queue.length === 0) {
            this.isBackpressured = this.input.write(chunk) === false;
            return;
        }

        this.queue.push(chunk);
        this.queuedBytes += chunk.length;
        if (this.queuedBytes > this.maxBufferSize) {
            this.fail(new Error(`RealtimeEncodeBufferOverflow: ${this.queuedBytes} > ${this.maxBufferSize}`));
        }
    }

    public end(): void {
        if (this.isFinished === true || this.isEndRequested === true) {
            return;
        }

        this.isEndRequested = true;
        this.endWhenDrained();
    }

    public destroy(): void {
        if (this.isFinished === true) {
            return;
        }

        this.isFinished = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.removeListeners();
        this.input.destroy();
    }

    private readonly onDrain = (): void => {
        if (this.isFinished === true) {
            return;
        }

        this.isBackpressured = false;
        while (this.queue.length > 0 && this.isBackpressured === false) {
            const chunk = this.queue.shift();
            if (typeof chunk === 'undefined') {
                break;
            }
            this.queuedBytes -= chunk.length;
            this.isBackpressured = this.input.write(chunk) === false;
        }
        this.endWhenDrained();
    };

    private readonly onInputError = (error: Error): void => {
        this.fail(error);
    };

    private endWhenDrained(): void {
        if (this.isEndRequested === false || this.isBackpressured === true || this.queue.length > 0) {
            return;
        }

        this.isFinished = true;
        this.removeListeners();
        this.input.end();
    }

    private fail(error: Error): void {
        if (this.isFinished === true) {
            return;
        }

        this.isFinished = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.removeListeners();
        this.input.destroy();
        this.onFailure(error);
    }

    private removeListeners(): void {
        this.input.removeListener('drain', this.onDrain);
        this.input.removeListener('error', this.onInputError);
    }
}
