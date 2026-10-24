import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeReserve, makeStreamCreator } from './_harness';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('[RE-9.2] time-specified stream end timer', () => {
    it('bounds raw 4K program streams and follows an extended end without closing another stream', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const raw = new PassThrough();
        const mx = new PassThrough();
        const close = vi.fn();
        const harness = makeStreamCreator({
            config: { recordedBS4KFormat: 'mmts', timeSpecifiedEndMargin: 2 },
            tunerServerAccess: { openProgramStream: vi.fn(async ({ programId }) => ({
                close: programId === 123 ? close : vi.fn(), stream: programId === 123 ? raw : mx,
            })) },
        });
        const reserve = makeReserve({ id: 491, channelType: 'BS4K', programId: 123,
            isConflict: true, startAt: 999_000, endAt: 1_030_000 });
        await harness.model.create(reserve, undefined, { isTimeSpecifiedEndExternallyScheduled: true });
        await harness.model.create(makeReserve({ id: 492, channelType: 'GR', programId: 124,
            isConflict: true, startAt: 999_000, endAt: 1_030_000 }));
        harness.model.changeEndAt({ ...reserve, endAt: 1_040_000 });
        await vi.advanceTimersByTimeAsync(32_000);
        expect(raw.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(raw.destroyed).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        expect(mx.destroyed).toBe(false);
        mx.destroy();
    });
    it('closes the assigned tuner stream and its handle when the reservation end plus margin elapses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const stream = new PassThrough();
        const close = vi.fn();
        const harness = makeStreamCreator({
            config: { timeSpecifiedEndMargin: 2 },
            tunerServerAccess: { openServiceStream: vi.fn(async () => ({ close, stream })) },
        });
        harness.model.setTuner([{ types: ['GR'] }]);
        const reserve = makeReserve({
            channelType: 'GR',
            id: 491,
            isConflict: false,
            isTimeSpecified: true,
            programId: null,
            startAt: 999_000,
            endAt: 1_030_000,
        });

        await expect(harness.model.create(reserve)).resolves.toBe(stream);
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

        await vi.advanceTimersByTimeAsync(31_999);
        expect(close).not.toHaveBeenCalled();
        expect(stream.destroyed).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        expect(close).toHaveBeenCalledTimes(1);
        expect(stream.destroyed).toBe(true);
    });
});
