import { describe, expect, it, vi } from 'vitest';
import { makeModel, makeReserve } from './_harness';

describe('fork reservation options', () => {
    it('normalizes blank save fields while preserving explicit format text', () => {
        const { model } = makeModel();
        const reserve = makeReserve();
        model.setSaveOptionToReserve(reserve, { parentDirectoryName: '', directory: '  ', recordedFormat: '%UUID%' });
        expect(reserve.parentDirectoryName).toBeNull();
        expect(reserve.directory).toBeNull();
        expect(reserve.recordedFormat).toBe('%UUID%');
    });
    it('matches normalized time-rule keywords and permits absent guide data', async () => {
        const findChannelIdAndTime = vi.fn().mockResolvedValue({ name: 'ＡＢＣ 番組[字]' });
        const { model } = makeModel({ programDB: { findChannelIdAndTime } });
        const rule = { id: 1, searchOption: { keyword: 'abc 番組' } };
        expect(await model.isTimeSpecificationRuleMatched(rule, 1, 100)).toBe(true);
        findChannelIdAndTime.mockResolvedValue({ name: '別番組' });
        expect(await model.isTimeSpecificationRuleMatched(rule, 1, 100)).toBe(false);
        findChannelIdAndTime.mockResolvedValue(null);
        expect(await model.isTimeSpecificationRuleMatched(rule, 1, 100)).toBe(true);
    });
});
