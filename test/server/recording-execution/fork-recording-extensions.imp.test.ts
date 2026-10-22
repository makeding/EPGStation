import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const snapshot = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT as string;
const loadDefault = <T>(modulePath: string): T => (require(join(snapshot, modulePath)) as { default: T }).default;

const BoundedProcessInput = loadDefault<
    new (
        input: NodeJS.WritableStream,
        maxBufferSize: number,
        onFailure: (error: Error) => void,
    ) => {
        write(chunk: Buffer): void;
    }
>('lib/BoundedProcessInput.js');
const BufferedWriteStream = loadDefault<any>('lib/BufferedWriteStream.js');
const RecordingDuplicatePolicy = loadDefault<{
    canCheck(program: { name: string; description?: string | null }): boolean;
    isDuplicate(
        program: { channelId: number; description?: string | null; endAt: number; name: string; startAt: number },
        history: { channelId: number; description?: string | null; endAt: number; name: string },
        periodDays?: number,
        now?: number,
    ): boolean;
}>('model/operator/RecordingDuplicatePolicy.js');
const RecorderModel = loadDefault<{ prototype: Record<string, unknown> }>('model/operator/recording/RecorderModel.js');
const RecordingStreamCreator = loadDefault<any>('model/operator/recording/RecordingStreamCreator.js');
const ReservationManageModel = loadDefault<any>('model/operator/reservation/ReservationManageModel.js');
const { saveBangumiCover } = require(join(snapshot, 'model/operator/recording/BangumiCoverUtil.js')) as {
    saveBangumiCover(directory: string, bangumiId: number, request: typeof fetch): Promise<void>;
};

afterEach(() => {
    vi.useRealTimers();
});

describe('fork recording extensions', () => {
    it('does not enqueue a chunk again when the output accepts it with backpressure', () => {
        const output = new PassThrough();
        const write = vi.spyOn(output, 'write').mockReturnValue(false);
        const buffered = new BufferedWriteStream({
            logger: { system: { error: vi.fn(), warn: vi.fn() } },
            maxBufferSize: 1024,
            reserveId: 1,
            warningThreshold: 80,
        });
        buffered.setWriteStream(output);

        buffered.write(Buffer.from('accepted-once'));
        expect(buffered.getBufferStats().used).toBe(0);
        output.emit('drain');
        expect(write).toHaveBeenCalledOnce();

        buffered.destroy();
        output.destroy();
    });

    it('fails only the optional realtime sidecar when its bounded input queue overflows', () => {
        const input = new PassThrough({ highWaterMark: 1 });
        input.pause();
        const onFailure = vi.fn();
        const queue = new BoundedProcessInput(input, 4, onFailure);

        queue.write(Buffer.alloc(2));
        queue.write(Buffer.alloc(5));

        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure.mock.calls[0][0]).toMatchObject({
            message: 'RealtimeEncodeBufferOverflow: 5 > 4',
        });
        expect(input.destroyed).toBe(true);
    });

    it('keeps duplicate suppression conservative and episode-aware', () => {
        const now = 2_000_000;
        const program = {
            channelId: 10,
            endAt: now + 60_000,
            name: 'アニメ [再] 第12話',
            startAt: now + 1_000,
        };
        const history = {
            channelId: 10,
            endAt: now - 1_000,
            name: 'アニメ 第12話',
        };

        expect(RecordingDuplicatePolicy.canCheck(program)).toBe(true);
        expect(RecordingDuplicatePolicy.isDuplicate(program, history, undefined, now)).toBe(true);
        expect(
            RecordingDuplicatePolicy.isDuplicate(
                { ...program, name: 'アニメ [再] 第12話〜第13話' },
                history,
                undefined,
                now,
            ),
        ).toBe(false);
        expect(RecordingDuplicatePolicy.isDuplicate(program, { ...history, channelId: 11 }, undefined, now)).toBe(
            false,
        );
    });

    it('propagates removeDataBroadcast through manual and rule reservations', () => {
        const model: any = Object.create(ReservationManageModel.prototype);
        const manual: Record<string, unknown> = {};
        model.setManualReserveOption({ allowEndLack: false, removeDataBroadcast: true }, manual);
        expect(manual.removeDataBroadcast).toBe(true);

        const ruleReserve: Record<string, unknown> = {};
        model.setProgramToRuleReserve(
            ruleReserve,
            null,
            {
                id: 8,
                reserveOption: { allowEndLack: false, removeDataBroadcast: true },
                updateCnt: 3,
            },
            1234,
        );
        expect(ruleReserve.removeDataBroadcast).toBe(true);
    });

    it('reports configured network tuner types across the full NW1 through NW40 range', () => {
        const model = new ReservationManageModel(
            { getLogger: () => ({ system: {} }) },
            { getConfig: () => ({}) },
            {},
            {},
            {},
            {},
            {},
            {},
            {},
        );

        model.setTuners([{ types: ['NW1', 'NW40'] }]);

        expect(model.getBroadcastStatus()).toMatchObject({ NW1: true, NW2: false, NW40: true });
    });

    it('keeps BS4K MMTS undecoded for program and time-specified service streams', async () => {
        const stream = new PassThrough();
        const openProgramStream = vi.fn(async () => ({ close: vi.fn(), stream }));
        const openServiceStream = vi.fn(async () => ({ close: vi.fn(), stream }));
        const model = Object.create(RecordingStreamCreator.prototype);
        model.config = {
            conflictPriority: 9,
            recPriority: 2,
            recordedBS4KFormat: 'mmts',
            timeSpecifiedEndMargin: 0,
            timeSpecifiedStartMargin: 0,
        };
        model.tunerServerAccess = { openProgramStream, openServiceStream };
        model.adoptStream = (handle: { stream: PassThrough }) => handle.stream;

        const common = {
            channelId: 101,
            channelType: 'BS4K',
            endAt: Date.now() + 60_000,
            isConflict: false,
            startAt: Date.now(),
        };
        await model.getStream({ ...common, programId: 201 });
        await model.getStream({ ...common, programId: null }, undefined, {
            isTimeSpecifiedEndExternallyScheduled: true,
        });

        expect(openProgramStream).toHaveBeenCalledWith(expect.objectContaining({ decode: false, programId: 201 }));
        expect(openServiceStream).toHaveBeenCalledWith(expect.objectContaining({ decode: false, serviceId: 101 }));
        stream.destroy();
    });

    it('expands data-broadcast trimming only as a standalone realtime command token', () => {
        const model: any = Object.create(RecorderModel.prototype);
        model.config = {
            ffmpeg: 'synthetic-ffmpeg',
            ffprobe: 'synthetic-ffprobe',
            tsreplace: 'synthetic-tsreplace',
        };
        model.reserve = {
            channelType: 'GR',
            endAt: Date.now() + 30_000,
            removeDataBroadcast: true,
        };

        const command = model.parseRealtimeEncodeCommand('%TSREPLACE% -i - %DATA_BROADCAST_ARGS% -o encoded.ts');
        expect(command.bin).toBe('synthetic-tsreplace');
        expect(command.args).toContain('--smart-remove-typed');
        expect(command.args).toContain('--smart-remove-typed-duration');
        expect(() => model.parseRealtimeEncodeCommand('%TSREPLACE% x%DATA_BROADCAST_ARGS%')).toThrow(
            'DATA_BROADCAST_ARGSMustBeASeparateArgument',
        );

        model.reserve.channelType = 'BS4K';
        expect(model.parseRealtimeEncodeCommand('%TSREPLACE% %DATA_BROADCAST_ARGS% -i -').args).not.toContain(
            '--smart-remove-typed',
        );
    });

    it('stores a bounded Bangumi cover only from the expected image host', async () => {
        const directory = join(tmpdir(), `epgstation-fork-bangumi-cover-${process.pid}`);
        await rm(directory, { force: true, recursive: true });
        await mkdir(directory, { recursive: true });
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        images: {
                            large: new URL(
                                '/pic/cover/l/synthetic.jpg',
                                `${['h', 't', 't', 'p', 's'].join('')}://${['lain', 'bgm', 'tv'].join('.')}`,
                            ).toString(),
                        },
                    }),
                    {
                        headers: { 'content-type': 'application/json' },
                        status: 200,
                    },
                ),
            )
            .mockResolvedValueOnce(
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: { 'content-type': 'image/jpeg' },
                    status: 200,
                }),
            );
        try {
            await saveBangumiCover(directory, 123, request);
            expect(await readFile(join(directory, 'cover.jpg'))).toEqual(Buffer.from([1, 2, 3]));
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('emits the configured pre-start notification before preparation begins', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const model: any = Object.create(RecorderModel.prototype);
        model.config = { notification: { preNotifyMinutes: 15 } };
        model.eventEmitter = { emit: vi.fn() };
        model.isPrepRecording = false;
        model.isRecording = false;
        model.log = { system: { info: vi.fn() } };
        model.recordingEvent = { emitRecordingPreStart: vi.fn() };
        model.reserve = { id: 44, startAt: 1_000_000 + 20 * 60_000 };

        model.setPreNotifyTimer(model.reserve, Date.now());
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(model.recordingEvent.emitRecordingPreStart).toHaveBeenCalledWith(model.reserve);
        expect(model.preNotifyTimerId).toBeNull();
    });
});
