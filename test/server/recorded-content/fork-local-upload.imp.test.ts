import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const snapshot = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT as string;
const RecordedManageModel = (
    require(join(snapshot, 'model/operator/recorded/RecordedManageModel.js')) as {
        default: { prototype: Record<string, unknown> };
    }
).default;

describe('fork local video import', () => {
    it('keeps the source until the destination file has been registered', async () => {
        const sourcePath = join('synthetic-imports', 'show.ts');
        const directory = {
            close: vi.fn(async () => undefined),
            descriptorPath: 'synthetic-recorded',
            logicalPath: 'synthetic-recorded',
        };
        const unlink = vi.fn(async () => undefined);
        const model: any = Object.create(RecordedManageModel.prototype);
        model.log = { system: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } };
        model.recordedDB = { findId: vi.fn(async () => ({ thumbnails: [] })) };
        model.recordedEvent = { emitAddUploadedVideoFile: vi.fn(), emitAddVideoFile: vi.fn() };
        model.recordingUtilModel = { formatFilePathString: vi.fn() };
        model.uploadFileSystem = {
            realpath: vi.fn(async (value: string) => value),
            stat: vi.fn(async () => ({ size: 1024 })),
            unlink,
        };
        model.videoUtil = { getParentDirPath: vi.fn(() => 'synthetic-recorded') };
        model.prepareUploadDirectory = vi.fn(async () => directory);
        model.placeUploadedFile = vi.fn(async (...args: unknown[]) => {
            expect(unlink).not.toHaveBeenCalled();
            expect(args.slice(0, 3)).toEqual([sourcePath, directory, 'show.ts']);
            expect(args[4]).toBe(false);
            return {
                descriptorPath: join('synthetic-recorded', 'show.ts'),
                logicalPath: join('synthetic-recorded', 'show.ts'),
            };
        });
        model.assertPinnedUploadDirectory = vi.fn(async () => undefined);
        model.insertVideoFile = vi.fn(async () => 77);

        await model.addUploadedVideoFile({
            fileType: 'ts',
            localFilePath: sourcePath,
            parentDirectoryName: 'main',
            recordedId: 11,
            viewName: 'Imported TS',
        });

        expect(model.insertVideoFile).toHaveBeenCalledOnce();
        expect(unlink).toHaveBeenCalledWith(sourcePath);
        expect(directory.close).toHaveBeenCalledOnce();
    });
});
