import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RecordedDirInfo, StorageWarning, StorageWarningLevel } from '../../IConfigFile.js';
import { DiscoveredStorageMount } from './StorageMountDiscovery.js';

/** Lowest notified threshold in the current low-space episode, per filesystem. */
type WarningState = Record<string, number>;

export interface StorageWarningMonitorPorts {
    discover(): Promise<readonly DiscoveredStorageMount[]>;
    freeBytes(path: string): Promise<number>;
    notify(warning: StorageWarning): Promise<boolean>;
    load(): Promise<WarningState>;
    save(state: WarningState): Promise<void>;
    error(error: unknown): void;
}

export function storageWarningStateFile(path: string): Pick<StorageWarningMonitorPorts, 'load' | 'save'> {
    return {
        async load() {
            try {
                const state: unknown = JSON.parse(await readFile(path, 'utf8'));
                if (
                    state === null ||
                    typeof state !== 'object' ||
                    Array.isArray(state) ||
                    Object.values(state).some(
                        value => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
                    )
                )
                    throw new Error(`Invalid storage warning state: ${path}`);
                return state as WarningState;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
                throw error;
            }
        },
        async save(state) {
            await mkdir(dirname(path), { recursive: true });
            const pending = `${path}.pending`;
            try {
                await writeFile(pending, JSON.stringify(state), { mode: 0o600, flush: true });
                await rename(pending, path);
            } finally {
                await rm(pending, { force: true });
            }
        },
    };
}

export function storageWarningThresholds(entry: RecordedDirInfo): { level: StorageWarningLevel; threshold: number }[] {
    return [
        { level: 'warning' as const, threshold: entry.warningThreshold ?? 20 * 1024 },
        { level: 'critical' as const, threshold: entry.criticalThreshold ?? 10 * 1024 },
        { level: 'limit' as const, threshold: entry.limitThreshold ?? 5 * 1024 },
    ]
        .filter(item => Number.isFinite(item.threshold) && item.threshold >= 0)
        .sort((a, b) => a.threshold - b.threshold);
}

/** Notifications only: discovered mounts must never inherit automatic deletion. */
export default class StorageWarningMonitor {
    private state: WarningState | undefined;
    private dirty = false;
    private running: Promise<void> | undefined;

    constructor(private readonly ports: StorageWarningMonitorPorts) {}

    public check(): Promise<void> {
        if (this.running) return this.running;
        const pending = this.run().catch(error => this.ports.error(error));
        this.running = pending;
        void pending.finally(() => {
            this.running = undefined;
        });
        return pending;
    }

    private async persist(): Promise<void> {
        if (this.dirty && this.state) {
            await this.ports.save(this.state);
            this.dirty = false;
        }
    }

    private async run(): Promise<void> {
        this.state ??= await this.ports.load();
        await this.persist();
        for (const volume of await this.ports.discover()) {
            try {
                const free = (await this.ports.freeBytes(volume.path)) / 1024 / 1024;
                if (!Number.isFinite(free) || free < 0) throw new Error(`Invalid free capacity: ${volume.path}`);
                const thresholds = storageWarningThresholds(volume.entry);
                if (thresholds.length === 0) continue;
                if (free >= Math.max(...thresholds.map(item => item.threshold))) {
                    if (Object.hasOwn(this.state, volume.id)) {
                        delete this.state[volume.id];
                        this.dirty = true;
                        await this.persist();
                    }
                    continue;
                }
                const current = thresholds.find(item => free < item.threshold);
                const previous = this.state[volume.id];
                if (!current || (previous !== undefined && current.threshold >= previous)) continue;
                const delivered = await this.ports.notify({
                    ...current,
                    name: volume.name,
                    path: volume.path,
                    free,
                });
                if (delivered) {
                    this.state[volume.id] = current.threshold;
                    this.dirty = true;
                    await this.persist();
                }
            } catch (error) {
                this.ports.error(error);
            }
        }
    }
}
