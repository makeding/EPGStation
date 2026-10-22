import { describe, expect, it, vi } from 'vitest';
import { createStorageManager } from './_storage-harness';

describe('fork storage warning thresholds', () => {
    it('notifies only on escalation and rearms after recovery, including warning-only entries', async () => {
        const entry = { name: 'recorded', path: 'synthetic-storage', warningThreshold: 100, criticalThreshold: 50 };
        const { manager, deleteRecorded } = createStorageManager({ entries: [entry], intervalSeconds: 1 });
        const notify = vi.fn();
        (manager as any).notificationManage = { addStorageWarning: notify };
        for (const free of [90, 80, 40, 70, 110, 90]) {
            manager.getFreeSize = vi.fn(async () => free * 1024 * 1024);
            await manager.check([entry]);
        }
        expect(notify.mock.calls.map(([event]) => event.level)).toEqual(['warning', 'critical', 'warning']);
        expect(deleteRecorded).not.toHaveBeenCalled();
    });
    it('notifies for a limit-only entry without changing its none action', async () => {
        const entry = { name: 'recorded', path: 'synthetic-storage', limitThreshold: 10, action: 'none' as const };
        const { manager, deleteRecorded } = createStorageManager({ entries: [entry], intervalSeconds: 1 });
        const notify = vi.fn();
        (manager as any).notificationManage = { addStorageWarning: notify };
        manager.getFreeSize = vi.fn(async () => 5 * 1024 * 1024);
        await manager.check([entry]);
        expect(notify).toHaveBeenCalledWith({
            name: entry.name,
            path: entry.path,
            level: 'limit',
            free: 5,
            threshold: 10,
        });
        expect(deleteRecorded).not.toHaveBeenCalled();
    });
});
