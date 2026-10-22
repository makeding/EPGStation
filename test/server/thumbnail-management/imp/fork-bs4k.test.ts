import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupHarness, makeModel } from './_thumbnail-harness';
afterEach(cleanupHarness);
describe('fork BS4K thumbnail policy', () => {
    it.each(['BS4K', 'GR'])('skips only BS4K before thumbnail processing: %s', async channelType => {
        const { model } = makeModel();
        model.channelDB = { findId: vi.fn(async () => ({ channelType })) };
        model.recordedDB.findId = vi.fn(async () => ({ channelId: 1 }));
        const reachedPipeline = new Error('pipeline reached');
        model.prepareVideoFile = vi.fn(async () => {
            throw reachedPipeline;
        });
        if (channelType === 'BS4K') {
            await model.create(11);
            expect(model.prepareVideoFile).not.toHaveBeenCalled();
        } else {
            await expect(model.create(11)).rejects.toBe(reachedPipeline);
        }
    });
});
