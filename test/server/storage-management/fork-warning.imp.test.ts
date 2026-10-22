import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const snapshot = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT!;
const { default: StorageWarningMonitor } = await import(
    join(snapshot, 'model/operator/storage/StorageWarningMonitor.js')
);

const MiB = 1024 ** 2;
function setup() {
    const entry = { name: 'recorded', path: '/recorded' };
    const volumes = [
        { id: 'disk-a', path: '/recorded', name: 'recorded', entry },
        { id: 'disk-b', path: '/recorded/2026-07', name: 'recorded (2026-07)', entry },
    ];
    let saved: Record<string, number> = {};
    const free = new Map([
        ['/recorded', 1_000_000],
        ['/recorded/2026-07', 30 * 1024],
    ]);
    const ports = {
        discover: vi.fn(async () => volumes),
        freeBytes: vi.fn(async (path: string) => free.get(path)! * MiB),
        notify: vi.fn(async () => true),
        load: vi.fn(async () => ({ ...saved })),
        save: vi.fn(async (state: Record<string, number>) => {
            saved = { ...state };
        }),
        error: vi.fn(),
    };
    return { free, ports, monitor: new StorageWarningMonitor(ports) };
}

describe('mount-aware persistent capacity warning', () => {
    it('checks the full child disk despite a roomy parent, sends each level once, and survives restart', async () => {
        const { free, ports, monitor } = setup();
        for (const gib of [20, 19, 18, 9, 15, 9, 4, 8, 4]) {
            free.set('/recorded/2026-07', gib * 1024);
            await monitor.check();
        }
        expect(ports.notify.mock.calls.map(([warning]: any) => warning.threshold)).toEqual([
            20 * 1024,
            10 * 1024,
            5 * 1024,
        ]);
        expect(ports.notify.mock.calls.every(([warning]: any) => warning.path === '/recorded/2026-07')).toBe(true);
        await new StorageWarningMonitor(ports).check();
        expect(ports.notify).toHaveBeenCalledTimes(3);
        free.set('/recorded/2026-07', 20 * 1024);
        await monitor.check();
        free.set('/recorded/2026-07', 19 * 1024);
        await new StorageWarningMonitor(ports).check();
        expect(ports.notify).toHaveBeenCalledTimes(4);
        expect(ports.error).not.toHaveBeenCalled();
    });

    it('coalesces a sudden drop, retries failed delivery, and shares overlapping checks', async () => {
        const { free, ports, monitor } = setup();
        free.set('/recorded/2026-07', 4 * 1024);
        ports.notify.mockResolvedValueOnce(false);
        await Promise.all([monitor.check(), monitor.check()]);
        expect(ports.notify).toHaveBeenCalledTimes(1);
        expect(ports.save).not.toHaveBeenCalled();
        await monitor.check();
        expect(ports.notify).toHaveBeenCalledTimes(2);
        expect(ports.notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'limit', threshold: 5 * 1024 }));
        await monitor.check();
        expect(ports.notify).toHaveBeenCalledTimes(2);
    });

    it('keeps other disks monitored when a capacity read fails', async () => {
        const { free, ports, monitor } = setup();
        free.set('/recorded/2026-07', 9 * 1024);
        ports.freeBytes.mockRejectedValueOnce(new Error('unmounted'));
        await monitor.check();
        expect(ports.error).toHaveBeenCalledOnce();
        expect(ports.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'critical' }));
    });

    it('retains sent state in memory and retries persistence before sending again', async () => {
        const { free, ports, monitor } = setup();
        free.set('/recorded/2026-07', 19 * 1024);
        ports.save.mockRejectedValueOnce(new Error('state disk unavailable'));
        await monitor.check();
        await monitor.check();
        await new StorageWarningMonitor(ports).check();
        expect(ports.notify).toHaveBeenCalledOnce();
        expect(ports.save).toHaveBeenCalledTimes(2);
    });
});
