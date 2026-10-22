import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface DiscoveryRuntime {
    parseLinuxMountInfo(contents: string): Array<{
        filesystemType: string;
        majorMinor: string;
        mountPoint: string;
        source: string;
    }>;
    selectStorageMounts(
        roots: Array<{ entry: { name: string; path: string }; path: string }>,
        mounts: Array<{ filesystemType: string; majorMinor: string; mountPoint: string; source: string }>,
    ): Array<{ entry: { name: string; path: string }; id: string; name: string; path: string }>;
    discoverStorageMounts(
        entries: Array<{ name: string; path: string }>,
        options: {
            platform: NodeJS.Platform;
            realpath: (path: string) => Promise<string>;
            readMountInfo?: () => Promise<string>;
            stat?: (path: string) => Promise<{ dev: number }>;
            onError?: (entry: { name: string; path: string }, error: unknown) => void;
        },
    ): Promise<Array<{ entry: { name: string; path: string }; id: string; name: string; path: string }>>;
}

const require = createRequire(join(process.cwd(), 'package.json'));
const compiledSnapshot = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT;
if (compiledSnapshot === undefined) throw new Error('The compiled server snapshot is required');
const discovery = require(
    join(compiledSnapshot, 'model', 'operator', 'storage', 'StorageMountDiscovery.js'),
) as DiscoveryRuntime;

const mountInfo = [
    '24 20 8:1 / /synthetic-recorded rw,relatime - ext4 /dev/synthetic-device-a rw',
    '25 24 8:32 / /synthetic-recorded/2026-07 rw,relatime - ext4 /dev/synthetic-device-c rw',
    '26 24 8:32 / /synthetic-recorded/2026-07-alias rw,relatime - ext4 /dev/synthetic-device-c rw',
    '27 24 0:45 / /synthetic-recorded/archive\\040disk rw,relatime - fuse.mergerfs synthetic-archive\\040disk rw',
].join('\n');

describe('storage mount discovery', () => {
    it('[SM-4.1] parses escaped mount points and sources from proc mountinfo', () => {
        expect(discovery.parseLinuxMountInfo(mountInfo)).toContainEqual({
            filesystemType: 'fuse.mergerfs',
            majorMinor: '0:45',
            mountPoint: '/synthetic-recorded/archive disk',
            source: 'synthetic-archive disk',
        });
    });

    it('[SM-4.2][SM-4.3] retains a configured root, discovers nested filesystems, and deduplicates bind aliases', () => {
        const entry = { name: 'recorded', path: '/synthetic-configured/recorded' };
        const result = discovery.selectStorageMounts(
            [{ entry, path: '/synthetic-recorded' }],
            discovery.parseLinuxMountInfo(mountInfo),
        );

        expect(result).toEqual([
            { entry, id: 'linux:ext4:/dev/synthetic-device-a', name: 'recorded', path: '/synthetic-recorded' },
            {
                entry,
                id: 'linux:ext4:/dev/synthetic-device-c',
                name: 'recorded (2026-07)',
                path: '/synthetic-recorded/2026-07',
            },
            {
                entry,
                id: 'linux:fuse.mergerfs:0:45',
                name: 'recorded (archive disk)',
                path: '/synthetic-recorded/archive disk',
            },
        ]);
    });

    it('[SM-4.4] resolves symlinked configured roots before selecting nested mounts and preserves the entry policy', async () => {
        const entry = { name: 'recorded', path: '/synthetic-configured/link' };
        await expect(
            discovery.discoverStorageMounts([entry], {
                platform: 'linux',
                readMountInfo: async () => mountInfo,
                realpath: async configuredPath => {
                    expect(configuredPath).toBe('/synthetic-configured/link');
                    return '/synthetic-recorded';
                },
            }),
        ).resolves.toMatchObject([
            { entry, name: 'recorded', path: '/synthetic-recorded' },
            { entry, name: 'recorded (2026-07)', path: '/synthetic-recorded/2026-07' },
            { entry, name: 'recorded (archive disk)', path: '/synthetic-recorded/archive disk' },
        ]);
    });

    it('[SM-4.5] falls back to real paths and stat device identities outside Linux', async () => {
        const first = { name: 'first', path: '/synthetic-configured/first' };
        const alias = { name: 'alias', path: '/synthetic-configured/alias' };
        await expect(
            discovery.discoverStorageMounts([first, alias], {
                platform: 'darwin',
                realpath: async configuredPath =>
                    configuredPath === first.path ? '/synthetic-volumes/recorded' : '/synthetic-volumes/recorded-alias',
                stat: async () => ({ dev: 17 }),
            }),
        ).resolves.toEqual([{ entry: first, id: 'device:17', name: 'first', path: '/synthetic-volumes/recorded' }]);
    });

    it('[SM-4.6] reports an inaccessible root and still discovers the remaining roots', async () => {
        const inaccessible = { name: 'inaccessible', path: '/synthetic-configured/missing' };
        const usable = { name: 'usable', path: '/synthetic-configured/usable' };
        const failure = new Error('not mounted');
        const errors: Array<{ entry: { name: string; path: string }; error: unknown }> = [];

        await expect(
            discovery.discoverStorageMounts([inaccessible, usable], {
                platform: 'darwin',
                realpath: async configuredPath => {
                    if (configuredPath === inaccessible.path) throw failure;
                    return '/synthetic-volumes/usable';
                },
                stat: async () => ({ dev: 18 }),
                onError: (entry, error) => errors.push({ entry, error }),
            }),
        ).resolves.toEqual([{ entry: usable, id: 'device:18', name: 'usable', path: '/synthetic-volumes/usable' }]);
        expect(errors).toEqual([{ entry: inaccessible, error: failure }]);
    });

    it('[SM-4.7] rejects empty or malformed Linux mountinfo instead of treating it as a healthy root', () => {
        expect(() => discovery.parseLinuxMountInfo('')).toThrow('Linux mountinfo is empty');
        expect(() => discovery.parseLinuxMountInfo('not-a-mountinfo-line')).toThrow('separator is missing');
    });

    it('[SM-4.8] uses major:minor for anonymous filesystems instead of collapsing every tmpfs source', () => {
        const entry = { name: 'recorded', path: '/synthetic-configured/recorded' };
        const result = discovery.selectStorageMounts(
            [{ entry, path: '/synthetic-recorded' }],
            discovery.parseLinuxMountInfo([
                '30 20 0:61 / /synthetic-recorded rw,relatime - tmpfs tmpfs rw',
                '31 30 0:62 / /synthetic-recorded/cache rw,relatime - tmpfs tmpfs rw',
            ].join('\n')),
        );
        expect(result.map(item => item.id)).toEqual(['linux:tmpfs:0:61', 'linux:tmpfs:0:62']);
    });

    it('[SM-4.9] reports a Linux root absent from mountinfo while monitoring the valid roots', async () => {
        const absent = { name: 'absent', path: '/synthetic-configured/absent' };
        const usable = { name: 'usable', path: '/synthetic-configured/usable' };
        const errors: Array<{ entry: { name: string; path: string }; error: unknown }> = [];

        await expect(
            discovery.discoverStorageMounts([absent, usable], {
                platform: 'linux',
                realpath: async configuredPath =>
                    configuredPath === absent.path ? '/synthetic-unmounted' : '/synthetic-recorded/2026-07',
                readMountInfo: async () => mountInfo,
                onError: (entry, error) => errors.push({ entry, error }),
            }),
        ).resolves.toEqual([
            {
                entry: usable,
                id: 'linux:ext4:/dev/synthetic-device-c',
                name: 'usable',
                path: '/synthetic-recorded/2026-07',
            },
        ]);
        expect(errors).toHaveLength(1);
        expect(errors[0].entry).toBe(absent);
        expect((errors[0].error as Error).message).toBe('no Linux mount found for recording root: /synthetic-unmounted');
    });
});
