import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { RecordedDirInfo } from '../../IConfigFile.js';

/** A Linux mount as described by `/proc/self/mountinfo`. */
export interface LinuxMountInfo {
    readonly filesystemType: string;
    readonly majorMinor: string;
    readonly mountPoint: string;
    readonly source: string;
}

/** A separately monitored filesystem below a configured recording root. */
export interface DiscoveredStorageMount {
    /** Stable filesystem identity used to avoid monitoring bind aliases twice. */
    readonly id: string;
    /** Resolved directory passed to capacity checks. */
    readonly path: string;
    /** Human-readable configured storage name, qualified for a nested mount. */
    readonly name: string;
    /** The configured entry whose thresholds and actions apply to this filesystem. */
    readonly entry: RecordedDirInfo;
}

export interface ResolvedRecordedRoot {
    readonly entry: RecordedDirInfo;
    readonly path: string;
}

interface FilesystemIdentity {
    readonly id: string;
}

export interface StorageMountDiscoveryOptions {
    /** Receives a configured root that could not be resolved or statted; discovery continues with the rest. */
    readonly onError?: (entry: RecordedDirInfo, error: unknown) => void | Promise<void>;
    readonly platform?: NodeJS.Platform;
    readonly readMountInfo?: () => Promise<string>;
    readonly realpath?: (path: string) => Promise<string>;
    readonly stat?: (path: string) => Promise<{ dev: number }>;
}

const decodeMountInfoField = (value: string): string =>
    value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

const isSameOrDescendant = (candidate: string, parent: string): boolean =>
    candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

const mountIdentity = (mount: LinuxMountInfo): FilesystemIdentity => {
    // Block-device sources remain useful when a device is remounted and receives a new major:minor number.
    // Anonymous filesystems commonly reuse names such as "tmpfs" or "overlay", so use their device identity.
    if (mount.source.startsWith('/dev/')) {
        return { id: `linux:${mount.filesystemType}:${mount.source}` };
    }
    return { id: `linux:${mount.filesystemType}:${mount.majorMinor}` };
};

/**
 * Parse only the fields needed for recording storage discovery from Linux mountinfo.
 * Mount paths and source names use the octal escaping defined by proc(5).
 */
export const parseLinuxMountInfo = (contents: string): LinuxMountInfo[] => {
    const mounts: LinuxMountInfo[] = [];
    for (const [index, line] of contents.split('\n').entries()) {
        if (line === '') continue;
        const separator = line.indexOf(' - ');
        if (separator === -1) throw new Error(`invalid Linux mountinfo line ${index + 1}: separator is missing`);
        const before = line.slice(0, separator).split(' ');
        const after = line.slice(separator + 3).split(' ');
        // mountinfo: id parent major:minor root mount-point options [optional...] - fstype source super-options
        if (before.length < 6 || after.length < 3 || !/^\d+:\d+$/.test(before[2])) {
            throw new Error(`invalid Linux mountinfo line ${index + 1}`);
        }
        mounts.push({
            filesystemType: after[0],
            majorMinor: before[2],
            mountPoint: decodeMountInfoField(before[4]),
            source: decodeMountInfoField(after[1]),
        });
    }
    if (mounts.length === 0) throw new Error('Linux mountinfo is empty');
    return mounts;
};

const closestContainingMount = (root: string, mounts: readonly LinuxMountInfo[]): LinuxMountInfo | undefined =>
    mounts
        .filter(mount => isSameOrDescendant(root, mount.mountPoint))
        .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];

const nestedMountName = (entry: RecordedDirInfo, root: string, mountedPath: string): string => {
    const relative = path.relative(root, mountedPath);
    return relative === '' ? entry.name : `${entry.name} (${relative})`;
};

/**
 * Select configured roots and every Linux mount nested below them.  Filesystem identities are
 * deduplicated across roots so bind mounts and repeated configuration do not emit duplicate checks.
 */
export const selectStorageMounts = (
    roots: readonly ResolvedRecordedRoot[],
    mounts: readonly LinuxMountInfo[],
): DiscoveredStorageMount[] => {
    const result: DiscoveredStorageMount[] = [];
    const seen = new Set<string>();
    const append = (entry: RecordedDirInfo, mountedPath: string, identity: FilesystemIdentity, name: string): void => {
        if (seen.has(identity.id)) return;
        seen.add(identity.id);
        result.push({ entry, id: identity.id, name, path: mountedPath });
    };

    for (const root of roots) {
        const containingMount = closestContainingMount(root.path, mounts);
        if (containingMount !== undefined) {
            append(root.entry, root.path, mountIdentity(containingMount), root.entry.name);
        }
        const nestedMounts = mounts
            .filter(mount => isSameOrDescendant(mount.mountPoint, root.path) && mount.mountPoint !== root.path)
            .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
        for (const mount of nestedMounts) {
            append(
                root.entry,
                mount.mountPoint,
                mountIdentity(mount),
                nestedMountName(root.entry, root.path, mount.mountPoint),
            );
        }
    }
    return result;
};

/** Resolve configured recording roots and discover every filesystem on which recordings can be written. */
export const discoverStorageMounts = async (
    entries: readonly RecordedDirInfo[],
    options: StorageMountDiscoveryOptions = {},
): Promise<DiscoveredStorageMount[]> => {
    const resolvePath = options.realpath ?? realpath;
    const roots: ResolvedRecordedRoot[] = [];
    const reportRootError = async (entry: RecordedDirInfo, error: unknown): Promise<void> => {
        try {
            await options.onError?.(entry, error);
        } catch {
            // A reporting failure must not hide the remaining recording roots.
        }
    };
    for (const entry of entries) {
        try {
            roots.push({ entry, path: await resolvePath(entry.path) });
        } catch (error) {
            await reportRootError(entry, error);
        }
    }
    if ((options.platform ?? process.platform) === 'linux') {
        const readMountInfo = options.readMountInfo ?? (() => readFile('/proc/self/mountinfo', 'utf8'));
        const mounts = parseLinuxMountInfo(await readMountInfo());
        const monitoredRoots: ResolvedRecordedRoot[] = [];
        for (const root of roots) {
            if (closestContainingMount(root.path, mounts) === undefined) {
                await reportRootError(root.entry, new Error(`no Linux mount found for recording root: ${root.path}`));
                continue;
            }
            monitoredRoots.push(root);
        }
        return selectStorageMounts(monitoredRoots, mounts);
    }

    const statPath = options.stat ?? stat;
    const result: DiscoveredStorageMount[] = [];
    const seen = new Set<number>();
    for (const root of roots) {
        let dev: number;
        try {
            ({ dev } = await statPath(root.path));
        } catch (error) {
            await reportRootError(root.entry, error);
            continue;
        }
        if (seen.has(dev)) continue;
        seen.add(dev);
        result.push({ entry: root.entry, id: `device:${dev}`, name: root.entry.name, path: root.path });
    }
    return result;
};
