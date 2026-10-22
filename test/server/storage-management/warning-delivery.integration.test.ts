import 'reflect-metadata';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const snapshot = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT!;
const { default: StorageWarningMonitor, storageWarningStateFile } = await import(
    join(snapshot, 'model/operator/storage/StorageWarningMonitor.js')
);
const { default: NotificationManageModel } = await import(
    join(snapshot, 'model/operator/notification/NotificationManageModel.js')
);
const { default: StorageManageModel } = await import(join(snapshot, 'model/operator/storage/StorageManageModel.js'));
const { default: PromiseQueue } = await import(join(snapshot, 'model/PromiseQueue.js'));

// Owned test state only (<1 MiB), removed before use and in finally; never contains production data.
const root = join(tmpdir(), 'epgstation-storage-warning-delivery-test');

describe('storage warning delivery and restart', () => {
    it('delivers the actual event over HTTP, persists acknowledgement, and starts without deletion thresholds', async () => {
        await rm(root, { recursive: true, force: true });
        const bodies: unknown[] = [];
        let status = 503;
        const server = createServer(async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            bodies.push(JSON.parse(body));
            res.writeHead(status).end('{}');
        });
        try {
            await mkdir(root, { recursive: true });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const address = server.address() as { port: number };
            const logger = { system: { error: vi.fn(), info: vi.fn() } };
            const entry = { name: 'synthetic-recorded', path: '/synthetic-recorded' };
            const config = {
                recorded: [entry],
                storageLimitCheckIntervalTime: 60,
                notification: {
                    webhooks: [{ trigger: 'storageWarning', url: `http://127.0.0.1:${address.port}/events` }],
                },
            };
            const configuration = { getConfig: () => config };
            const notifications = new NotificationManageModel(
                { getLogger: () => logger },
                configuration,
                new PromiseQueue(),
                {},
                {},
            );
            const stateFile = join(root, 'state.json');
            const ports = {
                discover: async () => [
                    {
                        id: 'july-disk',
                        path: '/synthetic-recorded/synthetic-season',
                        name: 'recorded (2026-07)',
                        entry,
                    },
                ],
                freeBytes: async () => 4 * 1024 ** 3,
                notify: (warning: unknown) => notifications.addStorageWarning(warning),
                ...storageWarningStateFile(stateFile),
                error: logger.system.error,
            };
            await new StorageWarningMonitor(ports).check();
            expect(bodies).toHaveLength(1);
            await expect(readFile(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
            status = 200;
            await new StorageWarningMonitor(ports).check();
            expect(bodies[1]).toEqual({
                event: 'storageWarning',
                storage: {
                    name: 'recorded (2026-07)',
                    path: '/synthetic-recorded/synthetic-season',
                    level: 'limit',
                    free: 4096,
                    threshold: 5120,
                },
            });
            expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ 'july-disk': 5120 });
            await new StorageWarningMonitor(ports).check();
            expect(bodies).toHaveLength(2);

            const deletion = vi.fn();
            const manager = new StorageManageModel(
                { getLogger: () => logger },
                configuration,
                {},
                { deleteForStoragePressure: deletion },
                {},
                notifications,
            );
            const check = vi.spyOn(manager.warningMonitor, 'check').mockResolvedValue(undefined);
            try {
                manager.start();
                expect(check).toHaveBeenCalledOnce();
                expect(manager.timerId).not.toBeNull();
                expect(deletion).not.toHaveBeenCalled();
            } finally {
                manager.stop();
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    });
});
