import * as child_process from 'child_process';
import * as events from 'events';
import * as fs from 'fs';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as shellQuote from 'shell-quote';
import * as stream from 'stream';
import * as mapid from '../../../../node_modules/mirakurun/api';
import * as apid from '../../../../api';
import DropLogFile from '../../../db/entities/DropLogFile';
import Recorded from '../../../db/entities/Recorded';
import RecordedHistory from '../../../db/entities/RecordedHistory';
import Reserve from '../../../db/entities/Reserve';
import VideoFile from '../../../db/entities/VideoFile';
import BoundedProcessInput from '../../../lib/BoundedProcessInput';
import BufferedWriteStream from '../../../lib/BufferedWriteStream';
import FileUtil from '../../../util/FileUtil';
import ProcessUtil from '../../../util/ProcessUtil';
import StrUtil from '../../../util/StrUtil';
import IDropLogFileDB from '../../db/IDropLogFileDB';
import IProgramDB from '../../db/IProgramDB';
import IRecordedDB from '../../db/IRecordedDB';
import IRecordedHistoryDB from '../../db/IRecordedHistoryDB';
import IReserveDB from '../../db/IReserveDB';
import IVideoFileDB from '../../db/IVideoFileDB';
import IRecordingEvent from '../../event/IRecordingEvent';
import IConfigFile from '../../IConfigFile';
import IConfiguration from '../../IConfiguration';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IMirakurunClientModel from '../../IMirakurunClientModel';
import IDropCheckerModel from './IDropCheckerModel';
import IRecorderModel from './IRecorderModel';
import IRecordingStreamCreator from './IRecordingStreamCreator';
import IRecordingUtilModel, { RecFilePathInfo } from './IRecordingUtilModel';

interface ProbeInfo {
    duration: number;
    streamTypes: string[];
}

/**
 * Recorder
 */
@injectable()
class RecorderModel implements IRecorderModel {
    private log: ILogger;
    private config: IConfigFile;
    private programDB: IProgramDB;
    private reserveDB: IReserveDB;
    private recordedDB: IRecordedDB;
    private recordedHistoryDB: IRecordedHistoryDB;
    private videoFileDB: IVideoFileDB;
    private dropLogFileDB: IDropLogFileDB;
    private streamCreator: IRecordingStreamCreator;
    private dropChecker: IDropCheckerModel;
    private recordingUtil: IRecordingUtilModel;
    private recordingEvent: IRecordingEvent;
    private mirakurunClientModel: IMirakurunClientModel;

    private reserve!: Reserve;
    private recordedId: apid.RecordedId | null = null;
    private videoFileId: apid.VideoFileId | null = null;
    private videoFileFulPath: string | null = null;
    private timerId: NodeJS.Timeout | null = null;
    private stream: http.IncomingMessage | null = null;
    private passThroughStreamForWrite: stream.PassThrough | null = null;
    private bufferedWriteStream: BufferedWriteStream | null = null;
    private recFile: fs.WriteStream | null = null;
    private tsreplaceProcess: child_process.ChildProcessWithoutNullStreams | null = null;
    private tsreplaceCompletion: Promise<Error | null> | null = null;
    private realtimeEncodeProcess: child_process.ChildProcessWithoutNullStreams | null = null;
    private realtimeEncodeInput: BoundedProcessInput | null = null;
    private realtimeEncodeCompletion: Promise<Error | null> | null = null;
    private realtimeEncodeError: Error | null = null;
    private realtimeEncodeProcessingPath: string | null = null;
    private realtimeEncodeFinalPath: string | null = null;
    private realtimeEncodeOnData: ((chunk: Buffer) => void) | null = null;
    private realtimeEncodeOnEnd: (() => void) | null = null;
    private realtimeEncodeKillTimer: NodeJS.Timeout | null = null;
    private isStopPrepRec: boolean = false;
    private isNeedDeleteReservation: boolean = true;
    private isPrepRecording: boolean = false;
    private isRecording: boolean = false;
    private isPlanToDelete: boolean = false;
    private isCanceledCallingFinished: boolean = false; // mirakurun の stream の終了検知をキャンセルするか
    private isRecEndStarted: boolean = false;
    private isRecordingFailed: boolean = false;
    private eventEmitter = new events.EventEmitter();

    private dropLogFileId: apid.DropLogFileId | null = null;

    private abortController: AbortController | null = null;

    // イベントリレータイマー
    private eventRelayTimerId: NodeJS.Timeout | null = null;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IConfiguration') configuration: IConfiguration,
        @inject('IProgramDB') programDB: IProgramDB,
        @inject('IReserveDB') reserveDB: IReserveDB,
        @inject('IRecordedDB') recordedDB: IRecordedDB,
        @inject('IRecordedHistoryDB') recordedHistoryDB: IRecordedHistoryDB,
        @inject('IVideoFileDB') videoFileDB: IVideoFileDB,
        @inject('IDropLogFileDB') dropLogFileDB: IDropLogFileDB,
        @inject('IRecordingStreamCreator')
        streamCreator: IRecordingStreamCreator,
        @inject('IDropCheckerModel') dropChecker: IDropCheckerModel,
        @inject('IRecordingUtilModel') recordingUtil: IRecordingUtilModel,
        @inject('IRecordingEvent') recordingEvent: IRecordingEvent,
        @inject('IMirakurunClientModel') mirakurunClientModel: IMirakurunClientModel,
    ) {
        this.log = logger.getLogger();
        this.config = configuration.getConfig();
        this.programDB = programDB;
        this.reserveDB = reserveDB;
        this.recordedDB = recordedDB;
        this.recordedHistoryDB = recordedHistoryDB;
        this.videoFileDB = videoFileDB;
        this.dropLogFileDB = dropLogFileDB;
        this.streamCreator = streamCreator;
        this.dropChecker = dropChecker;
        this.recordingUtil = recordingUtil;
        this.recordingEvent = recordingEvent;
        this.mirakurunClientModel = mirakurunClientModel;
    }

    /**
     * タイマーをセットする
     * @param reserve: Reserve 予約情報
     * @param isSuppressLog: boolean ログ出力を抑えるか
     * @return boolean セットに成功したら true を返す
     */
    public setTimer(reserve: Reserve, isSuppressLog: boolean): boolean {
        this.reserve = reserve;

        // 除外, 重複しているものはタイマーをセットしない
        if (this.reserve.isSkip === true || this.reserve.isOverlap === true) {
            return false;
        }

        const now = new Date().getTime();
        if (now >= this.reserve.endAt) {
            return false;
        }

        // 待機時間を計算
        let time = this.reserve.startAt - now - IRecordingStreamCreator.PREP_TIME;
        if (time < 0) {
            time = 0;
        }

        // タイマーをセット
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
        }

        if (isSuppressLog === false) {
            this.log.system.info(`set timer: ${this.reserve.id}, ${time}`);
        }
        this.timerId = setTimeout(async () => {
            try {
                this.prepRecord();
            } catch (err: any) {
                this.log.system.error(`failed prep record: ${this.reserve.id}`);
            }
        }, time);

        return true;
    }

    /**
     * 録画準備
     */
    private async prepRecord(retry: number = 0): Promise<void> {
        if (this.isStopPrepRec === true) {
            this.isPlanToDelete = false;
            this.emitCancelEvent();

            return;
        }

        this.log.system.info(`preprec: ${this.reserve.id}`);

        this.isPrepRecording = true;
        this.isRecording = false;
        this.isPlanToDelete = false;

        if (retry === 0) {
            // 録画準備開始通知
            this.recordingEvent.emitStartPrepRecording(this.reserve);
        }

        // 番組ストリームを取得する
        try {
            // 番組開始時刻が変更されたことに伴い番組間に重なりが生じ、当該番組が削除されている
            // NOTE: mirakurunの不具合に対処
            if (this.reserve.programId) {
                const program = await this.programDB.findId(this.reserve.programId);
                if (program === null) {
                    this.log.system.warn(
                        `the program data does not found in database. retry later, (reerveId: ${this.reserve.id}, programId: ${this.reserve.programId})`,
                    );
                    this.emitCancelEvent();
                    return;
                }
            }

            this.abortController = new AbortController();
            this.stream = await this.streamCreator.create(this.reserve, this.abortController.signal);

            // 録画準備のキャンセル or ストリーム取得中に予約が削除されていないかチェック
            if ((await this.reserveDB.findId(this.reserve.id)) === null) {
                this.log.system.error(`canceled preprec: ${this.reserve.id}`);
                this.destroyStream();
                this.emitCancelEvent();
            } else {
                await this.doRecord();
            }
        } catch (err: any) {
            if ((this.isStopPrepRec as any) === true) {
                this.destroyStream();
                this.emitCancelEvent();
                return;
            }

            this.log.system.error(`preprec failed: ${this.reserve.id}`);
            this.log.system.error(err);
            if (retry < 3) {
                // retry
                setTimeout(() => {
                    this.prepRecord(retry + 1);
                }, 1000 * 5); // 5s
            } else if (retry < 30) {
                // retry ここに来るのはチューナーが開けない or ソケットのハングアップとか？ //
                setTimeout(() => {
                    this.prepRecord(retry + 1);
                }, 1000 * 60); // 60s
            } else {
                this.isPrepRecording = false;
                // 録画準備失敗を通知
                this.recordingEvent.emitPrepRecordingFailed(this.reserve);
            }
        } finally {
            this.abortController = null;
        }
    }

    /**
     * 録画準備キャンセル完了時に発行するイベント
     */
    private emitCancelEvent(): void {
        this.isStopPrepRec = false;
        this.isPrepRecording = false;
        this.isRecording = false;

        this.eventEmitter.emit(RecorderModel.CANCEL_EVENT);
    }

    /**
     * strem 破棄
     * @param needesUnpip: boolean
     */
    private destroyStream(needesUnpip: boolean = true): void {
        // stop stream
        if (this.stream !== null) {
            try {
                if (needesUnpip === true) {
                    this.stream.unpipe();
                }
                this.stream.destroy();
                this.stream.push(null); // eof 通知
                this.stream.removeAllListeners('data');
                this.stream = null;
            } catch (err: any) {
                this.log.system.error(`destroy stream error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        if (this.passThroughStreamForWrite !== null) {
            try {
                if (needesUnpip === true) {
                    this.passThroughStreamForWrite.unpipe();
                }
                this.passThroughStreamForWrite.destroy();
                this.passThroughStreamForWrite = null;
            } catch (err: any) {
                this.log.system.error(`destroy pass through stream error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        if (this.tsreplaceProcess !== null) {
            try {
                this.tsreplaceProcess.stdin.destroy();
                this.tsreplaceProcess.stdout.unpipe();
                this.tsreplaceProcess.stdout.destroy();
                this.tsreplaceProcess.stderr.destroy();
                this.tsreplaceProcess.kill();
            } catch (err: any) {
                this.log.system.error(`destroy tsreplace error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        if (this.realtimeEncodeProcess !== null || this.realtimeEncodeInput !== null) {
            this.abortRealtimeEncode(new Error('RecordingStreamDestroyed'));
        }

        // stop buffered write stream
        if (this.bufferedWriteStream !== null) {
            try {
                // 終了時のバッファ統計をログに記録
                const stats = this.bufferedWriteStream.getBufferStats();
                if (stats.used > 0) {
                    this.log.system.info(
                        `recording buffer stats at end: ${stats.percentage.toFixed(1)}% used ` +
                            `(${stats.used} bytes), reserveId: ${this.reserve.id}`,
                    );
                }
                this.bufferedWriteStream.destroy();
                this.bufferedWriteStream = null;
            } catch (err: any) {
                this.log.system.error(`destroy buffered write stream error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        // stop save file
        if (this.recFile !== null) {
            try {
                this.recFile.removeAllListeners('error');
                this.recFile.end();
            } catch (err: any) {
                this.log.system.error(`end recFile error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        // stop drop check
        if (this.dropLogFileId !== null) {
            this.dropChecker.stop().catch(err => {
                this.log.system.error(`dropChecker stop error: ${this.reserve.id}`);
                this.log.system.error(err);
            });
        }
    }

    private async startDataBroadcastFilter(): Promise<stream.Writable> {
        if (this.bufferedWriteStream === null) {
            throw new Error('BufferedWriteStreamIsNull');
        }

        const durationSec = Math.max(0, this.reserve.endAt - Date.now()) / 1000;
        const args = ['-i', '-', '-o', '-', '--smart-remove-typed'];
        if (durationSec > 0) {
            args.push('--smart-remove-typed-duration', durationSec.toFixed(3));
        }

        this.log.system.info(
            `start tsreplace: ${this.config.tsreplace} ${args.join(' ')} reserveId: ${this.reserve.id}`,
        );

        const filterProcess = child_process.spawn(this.config.tsreplace, args);
        this.tsreplaceProcess = filterProcess;
        this.tsreplaceCompletion = new Promise(resolve => {
            let isResolved = false;
            const finish = (error: Error | null) => {
                if (isResolved === false) {
                    isResolved = true;
                    resolve(error);
                }
            };

            filterProcess.once('error', finish);
            filterProcess.once('close', (code, signal) => {
                if (this.tsreplaceProcess === filterProcess) {
                    this.tsreplaceProcess = null;
                }
                if (code === 0) {
                    finish(null);
                } else {
                    finish(new Error(`tsreplace exited with code ${code}, signal ${signal ?? 'none'}`));
                }
            });
        });

        filterProcess.stderr.setEncoding('utf8');
        let stderrBuffer = '';
        filterProcess.stderr.on('data', (data: string) => {
            stderrBuffer += data;
            const lines = stderrBuffer.split(/[\r\n]+/);
            stderrBuffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.length > 0) {
                    this.log.system.debug(`tsreplace: ${line}`);
                }
            }
        });
        filterProcess.stderr.once('end', () => {
            if (stderrBuffer.length > 0) {
                this.log.system.debug(`tsreplace: ${stderrBuffer}`);
            }
        });

        const spawnError = await new Promise<Error | null>(resolve => {
            filterProcess.once('spawn', () => resolve(null));
            filterProcess.once('error', err => resolve(err));
        });
        if (spawnError !== null) {
            if (this.tsreplaceProcess === filterProcess) {
                this.tsreplaceProcess = null;
            }
            this.tsreplaceCompletion = null;
            this.log.system.error(`failed to start tsreplace; record raw TS instead reserveId: ${this.reserve.id}`);
            this.log.system.error(spawnError);
            return this.bufferedWriteStream;
        }

        filterProcess.stdin.on('error', err => {
            this.log.system.error(`tsreplace stdin error reserveId: ${this.reserve.id}`);
            this.log.system.error(err);
        });
        filterProcess.stdout.on('error', err => {
            this.log.system.error(`tsreplace stdout error reserveId: ${this.reserve.id}`);
            this.log.system.error(err);
        });

        filterProcess.stdout.pipe(this.bufferedWriteStream);
        return filterProcess.stdin;
    }

    private async startRealtimeEncode(recPath: RecFilePathInfo): Promise<boolean> {
        const realtimeEncode = this.config.realtimeEncode;
        if (typeof realtimeEncode === 'undefined' || this.stream === null) {
            return false;
        }
        if (this.reserve.channelType === 'BS4K' && this.config.recordedBS4KFormat === 'mmts') {
            this.log.system.info(`skip realtime encode for raw BS4K MMTS reserveId: ${this.reserve.id}`);
            return false;
        }

        const outputPaths = await this.getRealtimeEncodeOutputPaths(recPath.fullPath, realtimeEncode.suffix);
        const output = fs.createWriteStream(outputPaths.processing, { flags: 'wx' });
        let command: { bin: string; args: string[] };
        try {
            command = this.parseRealtimeEncodeCommand(realtimeEncode.cmd);
        } catch (err: any) {
            output.destroy();
            await FileUtil.unlink(outputPaths.processing).catch(() => {});
            this.log.system.error(`invalid realtime encode command reserveId: ${this.reserve.id}`);
            this.log.system.error(err);
            return false;
        }

        this.log.system.info(
            `start realtime encode: ${command.bin} ${command.args.join(' ')} ` +
                `output: ${outputPaths.processing}, reserveId: ${this.reserve.id}`,
        );

        let encodeProcess: child_process.ChildProcessWithoutNullStreams;
        try {
            encodeProcess = child_process.spawn(command.bin, command.args);
        } catch (err: any) {
            output.destroy();
            await FileUtil.unlink(outputPaths.processing).catch(() => {});
            this.log.system.error(`failed to start realtime encode reserveId: ${this.reserve.id}`);
            this.log.system.error(err);
            return false;
        }

        this.realtimeEncodeProcess = encodeProcess;
        this.realtimeEncodeProcessingPath = outputPaths.processing;
        this.realtimeEncodeFinalPath = null;
        this.realtimeEncodeError = null;

        encodeProcess.stderr.setEncoding('utf8');
        let stderrBuffer = '';
        encodeProcess.stderr.on('data', (data: string) => {
            stderrBuffer += data;
            const lines = stderrBuffer.split(/[\r\n]+/);
            stderrBuffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.length > 0) {
                    this.log.system.debug(`realtime encode: ${line}`);
                }
            }
        });
        encodeProcess.stderr.once('end', () => {
            if (stderrBuffer.length > 0) {
                this.log.system.debug(`realtime encode: ${stderrBuffer}`);
            }
        });

        const processCompletion = new Promise<Error | null>(resolve => {
            let isResolved = false;
            const finish = (error: Error | null) => {
                if (isResolved === false) {
                    isResolved = true;
                    resolve(error);
                }
            };
            encodeProcess.once('error', finish);
            encodeProcess.once('close', (code, signal) => {
                if (code === 0) {
                    finish(null);
                } else {
                    finish(new Error(`realtime encode exited with code ${code}, signal ${signal ?? 'none'}`));
                }
            });
        });
        const outputCompletion = new Promise<Error | null>(resolve => {
            stream.finished(output, {}, err => resolve(err ?? null));
        });

        encodeProcess.stdout.pipe(output);
        output.once('error', err => this.abortRealtimeEncode(err));

        const maxBufferSize = (realtimeEncode.maxBufferSize ?? 256) * 1024 * 1024;
        this.realtimeEncodeInput = new BoundedProcessInput(encodeProcess.stdin, maxBufferSize, err => {
            this.abortRealtimeEncode(err);
        });

        this.realtimeEncodeCompletion = Promise.all([processCompletion, outputCompletion]).then(async results => {
            if (this.realtimeEncodeKillTimer !== null) {
                clearTimeout(this.realtimeEncodeKillTimer);
                this.realtimeEncodeKillTimer = null;
            }
            this.removeRealtimeEncodeStreamListeners();
            if (this.realtimeEncodeProcess === encodeProcess) {
                this.realtimeEncodeProcess = null;
            }
            this.realtimeEncodeInput = null;

            const error = this.realtimeEncodeError ?? results.find(result => result !== null) ?? null;
            if (error !== null) {
                await FileUtil.unlink(outputPaths.processing).catch(() => {});
            }
            return error;
        });

        const spawnError = await new Promise<Error | null>(resolve => {
            encodeProcess.once('spawn', () => resolve(null));
            encodeProcess.once('error', err => resolve(err));
        });
        if (spawnError !== null) {
            this.abortRealtimeEncode(spawnError);
            await this.realtimeEncodeCompletion;
            this.realtimeEncodeCompletion = null;
            this.realtimeEncodeProcessingPath = null;
            this.log.system.error(
                `failed to start realtime encode; continue raw recording reserveId: ${this.reserve.id}`,
            );
            this.log.system.error(spawnError);
            return false;
        }

        return true;
    }

    private attachRealtimeEncodeStream(): void {
        if (this.stream === null || this.realtimeEncodeInput === null) {
            return;
        }
        this.realtimeEncodeOnData = (chunk: Buffer) => this.realtimeEncodeInput?.write(chunk);
        this.realtimeEncodeOnEnd = () => this.realtimeEncodeInput?.end();
        this.stream.on('data', this.realtimeEncodeOnData);
        this.stream.once('end', this.realtimeEncodeOnEnd);
    }

    private parseRealtimeEncodeCommand(command: string): { bin: string; args: string[] } {
        const parsed = shellQuote.parse(command);
        const tokens: string[] = [];
        const durationSec = Math.max(0, this.reserve.endAt - Date.now()) / 1000;
        const shouldRemoveDataBroadcast =
            this.reserve.removeDataBroadcast === true && this.reserve.channelType !== 'BS4K';

        for (const entry of parsed) {
            if (typeof entry !== 'string') {
                throw new Error('RealtimeEncodeCommandDoesNotSupportShellOperators');
            }
            if (entry === '%DATA_BROADCAST_ARGS%') {
                if (shouldRemoveDataBroadcast === true) {
                    tokens.push('--smart-remove-typed');
                    if (durationSec > 0) {
                        tokens.push('--smart-remove-typed-duration', durationSec.toFixed(3));
                    }
                }
                continue;
            }
            if (entry.includes('%DATA_BROADCAST_ARGS%')) {
                throw new Error('DATA_BROADCAST_ARGSMustBeASeparateArgument');
            }

            tokens.push(
                entry
                    .replace(/%TSREPLACE%/g, this.config.tsreplace)
                    .replace(/%FFMPEG%/g, this.config.ffmpeg)
                    .replace(/%FFPROBE%/g, this.config.ffprobe)
                    .replace(/%NODE%/g, process.argv[0])
                    .replace(/%ROOT%/g, ProcessUtil.ROOT_PATH),
            );
        }

        const bin = tokens.shift();
        if (typeof bin === 'undefined' || bin.length === 0) {
            throw new Error('RealtimeEncodeCommandIsEmpty');
        }
        return { bin: bin, args: tokens };
    }

    private async getRealtimeEncodeOutputPaths(
        rawPath: string,
        suffix: string,
    ): Promise<{ final: string; processing: string }> {
        const extension = path.extname(rawPath);
        const stem = rawPath.slice(0, rawPath.length - extension.length);
        let conflict = 0;
        while (true) {
            const conflictSuffix = conflict === 0 ? '' : `(${conflict})`;
            const finalPath = `${stem}${conflictSuffix}${suffix}`;
            const processingPath = `${finalPath}.processing`;
            const isUsed = await Promise.all([
                fs.promises.access(finalPath).then(
                    () => true,
                    () => false,
                ),
                fs.promises.access(processingPath).then(
                    () => true,
                    () => false,
                ),
            ]);
            if (isUsed.every(value => value === false)) {
                return { final: finalPath, processing: processingPath };
            }
            conflict++;
        }
    }

    private abortRealtimeEncode(error: Error): void {
        if (this.realtimeEncodeError === null) {
            this.realtimeEncodeError = error;
            this.log.system.error(`realtime encode sidecar failed reserveId: ${this.reserve.id}`);
            this.log.system.error(error);
        }
        this.removeRealtimeEncodeStreamListeners();
        if (this.realtimeEncodeInput !== null) {
            this.realtimeEncodeInput.destroy();
            this.realtimeEncodeInput = null;
        }
        if (this.realtimeEncodeProcess !== null) {
            this.realtimeEncodeProcess.kill('SIGINT');
            if (this.realtimeEncodeKillTimer === null) {
                const processToKill = this.realtimeEncodeProcess;
                this.realtimeEncodeKillTimer = setTimeout(() => {
                    if (this.realtimeEncodeProcess === processToKill) {
                        processToKill.kill('SIGKILL');
                    }
                    this.realtimeEncodeKillTimer = null;
                }, 3000);
            }
        }
    }

    private removeRealtimeEncodeStreamListeners(): void {
        if (this.stream !== null && this.realtimeEncodeOnData !== null) {
            this.stream.removeListener('data', this.realtimeEncodeOnData);
        }
        if (this.stream !== null && this.realtimeEncodeOnEnd !== null) {
            this.stream.removeListener('end', this.realtimeEncodeOnEnd);
        }
        this.realtimeEncodeOnData = null;
        this.realtimeEncodeOnEnd = null;
    }

    private async finishRealtimeEncode(rawPath: string): Promise<void> {
        if (this.realtimeEncodeCompletion === null || this.realtimeEncodeProcessingPath === null) {
            return;
        }

        const completion = this.realtimeEncodeCompletion;
        const processingPath = this.realtimeEncodeProcessingPath;
        this.realtimeEncodeCompletion = null;
        const finishTimeout = new Error('RealtimeEncodeFinishTimeout');
        let timeoutId: NodeJS.Timeout | null = null;
        let error = await Promise.race([
            completion,
            new Promise<Error>(resolve => {
                timeoutId = setTimeout(() => resolve(finishTimeout), 60 * 1000);
            }),
        ]);
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        if (error === finishTimeout) {
            this.abortRealtimeEncode(finishTimeout);
            error = await completion;
        }
        if (error !== null) {
            this.realtimeEncodeProcessingPath = null;
            return;
        }

        try {
            await this.validateRealtimeEncode(rawPath, processingPath);
            const realtimeEncode = this.config.realtimeEncode;
            if (typeof realtimeEncode === 'undefined') {
                throw new Error('RealtimeEncodeConfigIsUndefined');
            }
            const finalPath = processingPath.slice(0, -'.processing'.length);
            await fs.promises.rename(processingPath, finalPath);
            this.realtimeEncodeProcessingPath = null;
            this.realtimeEncodeFinalPath = finalPath;
            this.log.system.info(`realtime encode validated: ${finalPath}, reserveId: ${this.reserve.id}`);
        } catch (err: any) {
            this.log.system.error(`realtime encode validation failed reserveId: ${this.reserve.id}`);
            this.log.system.error(err);
            await FileUtil.unlink(processingPath).catch(() => {});
            this.realtimeEncodeProcessingPath = null;
        }
    }

    private async validateRealtimeEncode(rawPath: string, encodedPath: string): Promise<void> {
        const [rawStat, encodedStat, rawInfo, encodedInfo] = await Promise.all([
            fs.promises.stat(rawPath),
            fs.promises.stat(encodedPath),
            this.probeFile(rawPath),
            this.probeFile(encodedPath),
        ]);
        if (rawStat.size === 0 || encodedStat.size === 0) {
            throw new Error('RealtimeEncodeOutputIsEmpty');
        }
        if (rawInfo.streamTypes.includes('video') === false || encodedInfo.streamTypes.includes('video') === false) {
            throw new Error('RealtimeEncodeVideoStreamIsMissing');
        }
        if (rawInfo.streamTypes.includes('audio') && encodedInfo.streamTypes.includes('audio') === false) {
            throw new Error('RealtimeEncodeAudioStreamIsMissing');
        }

        const tolerance = this.config.realtimeEncode?.durationTolerance ?? 2;
        const durationDifference = Math.abs(rawInfo.duration - encodedInfo.duration);
        if (durationDifference > tolerance) {
            throw new Error(`RealtimeEncodeDurationMismatch: ${durationDifference.toFixed(3)} > ${tolerance}`);
        }
    }

    private probeFile(filePath: string): Promise<ProbeInfo> {
        return new Promise<ProbeInfo>((resolve, reject) => {
            child_process.execFile(
                this.config.ffprobe,
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'format=duration',
                    '-show_entries',
                    'stream=codec_type',
                    '-of',
                    'json',
                    filePath,
                ],
                (err, stdout) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    try {
                        const result = JSON.parse(stdout);
                        const duration = Number(result.format?.duration);
                        if (Number.isFinite(duration) === false || duration <= 0) {
                            throw new Error('ProbeDurationIsInvalid');
                        }
                        resolve({
                            duration: duration,
                            streamTypes: Array.isArray(result.streams)
                                ? result.streams.map((item: any) => String(item.codec_type))
                                : [],
                        });
                    } catch (parseError: any) {
                        reject(parseError);
                    }
                },
            );
        });
    }

    private async publishRealtimeEncode(): Promise<void> {
        if (
            this.realtimeEncodeFinalPath === null ||
            this.recordedId === null ||
            this.videoFileId === null ||
            this.videoFileFulPath === null ||
            typeof this.config.realtimeEncode === 'undefined'
        ) {
            return;
        }

        const rawVideoFile = await this.videoFileDB.findId(this.videoFileId);
        if (rawVideoFile === null) {
            throw new Error('RawVideoFileIsNotFound');
        }

        const currentPath = this.realtimeEncodeFinalPath;
        const rawExtension = path.extname(this.videoFileFulPath);
        const expectedPath =
            this.videoFileFulPath.slice(0, this.videoFileFulPath.length - rawExtension.length) +
            this.config.realtimeEncode.suffix;
        let publishedPath = currentPath;
        if (currentPath !== expectedPath) {
            const targetPaths = await this.getRealtimeEncodeOutputPaths(
                this.videoFileFulPath,
                this.config.realtimeEncode.suffix,
            );
            try {
                await fs.promises.rename(currentPath, targetPaths.final);
            } catch (_renameError: any) {
                await fs.promises.copyFile(currentPath, targetPaths.final, fs.constants.COPYFILE_EXCL);
                await fs.promises.unlink(currentPath);
            }
            publishedPath = targetPaths.final;
        }

        try {
            const videoFile = new VideoFile();
            videoFile.parentDirectoryName = rawVideoFile.parentDirectoryName;
            videoFile.filePath = path.join(path.dirname(rawVideoFile.filePath), path.basename(publishedPath));
            videoFile.type = 'encoded';
            videoFile.name = this.config.realtimeEncode.name;
            videoFile.size = (await fs.promises.stat(publishedPath)).size;
            videoFile.recordedId = this.recordedId;
            await this.videoFileDB.insertOnce(videoFile);
            this.realtimeEncodeFinalPath = null;
            this.log.system.info(`published realtime encode: ${videoFile.filePath}, reserveId: ${this.reserve.id}`);
        } catch (err: any) {
            await FileUtil.unlink(publishedPath).catch(() => {});
            this.realtimeEncodeFinalPath = null;
            throw err;
        }
    }

    private async cleanupRealtimeEncodeFiles(): Promise<void> {
        const paths = [this.realtimeEncodeProcessingPath, this.realtimeEncodeFinalPath];
        this.realtimeEncodeProcessingPath = null;
        this.realtimeEncodeFinalPath = null;
        await Promise.all(
            paths.map(filePath => (filePath === null ? Promise.resolve() : FileUtil.unlink(filePath).catch(() => {}))),
        );
    }

    /**
     * 録画処理
     */
    private async doRecord(): Promise<void> {
        if (this.stream === null) {
            return;
        }

        // 録画キャンセル
        if (this.isStopPrepRec === true) {
            this.log.system.error(`cancel recording: ${this.reserve.id}`);
            this.destroyStream();
            this.emitCancelEvent();

            return;
        }

        this.isPrepRecording = false;
        this.isRecording = true;

        // 録画開始内部イベント発行
        // 時刻指定予約で録画準備中に endAt を変えようとした場合にこのイベントを受信してから変える
        this.eventEmitter.emit(RecorderModel.START_RECORDING_EVENT);

        // 保存先を取得
        const recPath = await this.recordingUtil.getRecPath(this.reserve, true);

        this.log.system.info(`recording: ${this.reserve.id} ${recPath.fullPath}`);

        // save stream
        // WriteStream を大きめの highWaterMark で作成
        const writeHighWaterMark = (this.config.recordingWriteHighWaterMark ?? 4096) * 1024;
        this.recFile = fs.createWriteStream(recPath.fullPath, {
            flags: 'a',
            highWaterMark: writeHighWaterMark,
        });
        this.recFile.once('error', async err => {
            // 書き込みエラー発生
            this.log.system.error(`recFile error reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`);
            this.log.system.error(err);
            if (this.stream === null) {
                this.cancel(false);
            } else {
                this.isCanceledCallingFinished = true; // mirakurun の stream の終了処理を行わないようにセット
                await this.recFailed(err).catch(err => {
                    this.log.system.fatal(
                        `Unexpected recFailed error: reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`,
                    );
                    this.log.system.fatal(err);
                });
            }
        });

        // BufferedWriteStream を作成して IO ピークを吸収
        const bufferSize = (this.config.recordingBufferSize ?? 512) * 1024 * 1024;
        const warningThreshold = this.config.recordingBufferWarningThreshold ?? 80;
        this.bufferedWriteStream = new BufferedWriteStream({
            maxBufferSize: bufferSize,
            warningThreshold: warningThreshold,
            logger: this.log,
            reserveId: this.reserve.id,
        });
        this.bufferedWriteStream.setWriteStream(this.recFile);

        this.log.system.info(
            `recording buffer initialized: ${bufferSize / (1024 * 1024)}MB, ` +
                `warning threshold: ${warningThreshold}%, reserveId: ${this.reserve.id}`,
        );

        const shouldRemoveDataBroadcast =
            this.reserve.removeDataBroadcast === true && this.reserve.channelType !== 'BS4K';
        if (this.reserve.removeDataBroadcast === true && this.reserve.channelType === 'BS4K') {
            this.log.system.info(`skip data broadcast trim for BS4K reserveId: ${this.reserve.id}`);
        }
        // Realtime encode is an optional sidecar. While it is active, the primary
        // file always receives the untouched TS and remains the only recording
        // success criterion. Type-D trimming is expanded into the sidecar command.
        const isRealtimeEncodeStarted = await this.startRealtimeEncode(recPath);
        const recordingInput =
            isRealtimeEncodeStarted === false && shouldRemoveDataBroadcast
                ? await this.startDataBroadcastFilter()
                : this.bufferedWriteStream;

        // drop checker
        if (this.config.isEnabledDropCheck === true) {
            // drop checker 用に PassThrough を作成
            this.passThroughStreamForWrite = new stream.PassThrough();

            let dropFilePath: string | null = null;
            try {
                await this.dropChecker.start(this.config.dropLog, recPath.fullPath, this.passThroughStreamForWrite);
                dropFilePath = this.dropChecker.getFilePath();
            } catch (err: any) {
                this.log.system.error(`drop check error: ${recPath.fullPath}`);
                this.log.system.error(err);
                dropFilePath = null;
            }

            // drop 情報を DB へ反映
            if (dropFilePath !== null) {
                const dropLogFile = new DropLogFile();
                dropLogFile.errorCnt = 0;
                dropLogFile.dropCnt = 0;
                dropLogFile.scramblingCnt = 0;
                dropLogFile.filePath = path.basename(dropFilePath);
                this.log.system.info(`add drop log file: ${dropFilePath}`);
                try {
                    this.dropLogFileId = await this.dropLogFileDB.insertOnce(dropLogFile);
                } catch (err: any) {
                    this.dropLogFileId = null;
                    this.log.system.error(`add drop log file error: ${dropFilePath}`);
                    this.log.system.error(err);
                }
            }

            // stream -> PassThrough -> tsreplace(optional) -> BufferedWriteStream
            //        \-> bounded realtime encode sidecar (optional)
            this.passThroughStreamForWrite.pipe(recordingInput);
            this.stream.pipe(this.passThroughStreamForWrite);
            this.attachRealtimeEncodeStream();
        } else {
            // stream -> tsreplace(optional) -> BufferedWriteStream
            //        \-> bounded realtime encode sidecar (optional)
            this.stream.pipe(recordingInput);
            this.attachRealtimeEncodeStream();
        }

        return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            if (this.stream === null) {
                reject(new Error('StreamIsNull'));

                return;
            }

            // stream データ受信のタイムアウト設定
            let isStreamTimeout = false; // stream データ受信がタイムアウトした場合は true
            const recordingTimeoutId = setTimeout(async () => {
                isStreamTimeout = true;
                this.log.system.error(`recording failed: ${this.reserve.id}`);

                if (this.stream !== null) {
                    this.stream.removeListener('data', onData); // stream データ受信時のコールバックの登録を削除
                    this.destroyStream();

                    // delete file
                    await FileUtil.unlink(recPath.fullPath).catch(err => {
                        this.log.system.error(`delete error: ${this.reserve.id} ${recPath.fullPath}`);
                        this.log.system.error(err);
                    });
                }

                reject(new Error('recordingStartError'));
            }, 1000 * 5);

            // stream データ受診時のコールバック関数定義
            const onData = async () => {
                clearTimeout(recordingTimeoutId);

                if (isStreamTimeout === true) {
                    // timeout が発生していたため何もしない
                    this.log.system.error(`stream is timeouted. reserveId: ${this.reserve.id}`);

                    return;
                }

                // 番組情報追加
                const recorded = await this.addRecorded(recPath);

                // 終了処理セット
                if (this.stream !== null) {
                    this.setEndProcess(this.stream);
                } else {
                    reject(new Error('StreamIsNull'));

                    return;
                }

                // 録画開始を通知
                this.recordingEvent.emitStartRecording(this.reserve, recorded);

                // program id が指定されていればイベントリレーの確認を行う
                if (this.reserve.programId !== null) {
                    // イベントリレーを確認するために番組終了時間間近にタイマーをセットする
                    this.setEventRelayTimer(this.reserve);
                }

                resolve();
            };

            // stream データ受診時のコールバック設定
            this.stream.once('data', onData);
        }).catch(err => {
            // 予想外の録画失敗エラー
            this.destroyStream();
            throw err;
        });
    }

    /**
     * 録画開始時の録画番組情報追加処理
     * @param recPath: RecFilePathInfo
     * @returns Promise<Recorded>
     */
    private async addRecorded(recPath: RecFilePathInfo): Promise<Recorded> {
        this.log.system.info(`add recorded ${this.reserve.id} ${recPath.fullPath}`);
        try {
            const recorded = await this.createRecorded();
            this.recordedId = await this.recordedDB.insertOnce(recorded);
            recorded.id = this.recordedId;
            this.log.system.info(`recording added reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`);

            // add video file
            const videoFile = new VideoFile();
            videoFile.parentDirectoryName = recPath.parendDir.name;
            videoFile.filePath = path.join(recPath.subDir, recPath.fileName);
            videoFile.type = 'ts';
            videoFile.name = 'TS';
            videoFile.recordedId = this.recordedId;
            this.log.system.info(`create video file: ${videoFile.filePath}`);
            this.videoFileId = await this.videoFileDB.insertOnce(videoFile);
            this.videoFileFulPath = recPath.fullPath;

            recorded.videoFiles = [videoFile];

            return recorded;
        } catch (err: any) {
            // DB 登録エラー
            this.log.system.error('add recorded DB error');
            this.log.system.error(err);
            this.destroyStream();

            // delete file
            await FileUtil.unlink(recPath.fullPath).catch(err => {
                this.log.system.error(`delete error: ${this.reserve.id} ${recPath.fullPath}`);
                this.log.system.error(err);
            });

            throw new Error('AddRecordedDBError');
        }
    }

    /**
     * 終了処理追加
     * @param s: Mirakurun からのストリーム
     * @returns Promise<Recorded>
     */
    private async setEndProcess(s: http.IncomingMessage): Promise<void> {
        this.log.system.info(`set stream.finished: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
        const writeFinishedTarget = this.bufferedWriteStream;
        const tsreplaceCompletion = this.tsreplaceCompletion;
        if (writeFinishedTarget === null) {
            await this.recFailed(new Error('BufferedWriteStreamIsNull'));

            return;
        }

        stream.finished(s, {}, async err => {
            // 終了処理が呼ばれていたら無視する
            if (this.isCanceledCallingFinished === true || this.isRecEndStarted === true) {
                return;
            }

            if (err) {
                this.log.system.error(
                    `stream.finished error: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                await this.recFailed(err);
            } else if (Date.now() + IRecordingStreamCreator.PREP_TIME < this.reserve.endAt) {
                this.log.system.error(
                    `recording stream ended early: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                await this.recFailed(new Error('RecordingStreamEndedEarly'));
            }
        });

        stream.finished(writeFinishedTarget, {}, async err => {
            // 終了処理が呼ばれていたら無視する
            if (this.isCanceledCallingFinished === true || this.isRecEndStarted === true) {
                return;
            }

            if (err) {
                this.log.system.error(
                    `write stream.finished error: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                await this.recFailed(err);

                return;
            }

            if (tsreplaceCompletion !== null) {
                const tsreplaceError = await tsreplaceCompletion;
                if (tsreplaceError !== null) {
                    this.log.system.error(
                        `tsreplace failed reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                    );
                    this.log.system.error(tsreplaceError);
                    await this.recFailed(tsreplaceError);
                    return;
                }
            }

            if (this.videoFileFulPath !== null) {
                await this.finishRealtimeEncode(this.videoFileFulPath);
            }

            if (Date.now() + IRecordingStreamCreator.PREP_TIME < this.reserve.endAt) {
                const earlyEndError = new Error('RecordingOutputEndedEarly');
                this.log.system.error(
                    `recording output ended early reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                await this.recFailed(earlyEndError);
                return;
            }

            await this.recEnd().catch(e => {
                this.log.system.fatal(
                    `unexpected recEnd error: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                this.log.system.fatal(e);
            });
        });
    }

    /**
     * 録画失敗処理
     * @param err: Error
     */
    private async recFailed(err: Error): Promise<void> {
        if (this.isRecordingFailed === true || this.isRecEndStarted === true) {
            return;
        }
        this.isRecordingFailed = true;

        this.destroyStream();
        this.log.system.error(`recording end error reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
        this.log.system.error(err);

        // 録画終了処理
        this.isNeedDeleteReservation = false;
        await this.recEnd().catch(e => {
            this.log.system.error(`recEnd error reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
            this.log.system.error(e);
        });

        // 録画終了処理失敗を通知
        let recorded: Recorded | null = null;
        if (this.recordedId !== null) {
            try {
                recorded = await this.recordedDB.findId(this.recordedId);
            } catch (e: any) {
                this.log.system.error(`reocrded is deleted: ${this.recordedId}`);
                recorded = null;
            }
        }
        this.recordingEvent.emitRecordingFailed(this.reserve, recorded);
    }

    /**
     * this.reserve から Recorded を生成する
     * @return Promise<Recorded>
     */
    private async createRecorded(): Promise<Recorded> {
        const recorded = new Recorded();
        if (this.recordedId !== null) {
            recorded.id = this.recordedId;
        }
        recorded.isRecording = this.isRecording;
        recorded.reserveId = this.reserve.id;
        recorded.ruleId = this.reserve.ruleId;
        recorded.programId = this.reserve.programId;
        recorded.channelId = this.reserve.channelId;
        recorded.startAt = this.reserve.startAt;
        recorded.endAt = this.reserve.endAt;
        recorded.duration = this.reserve.endAt - this.reserve.startAt;

        if (this.reserve.name !== null && this.reserve.halfWidthName !== null) {
            recorded.name = this.reserve.name;
            recorded.halfWidthName = this.reserve.halfWidthName;
            recorded.description = this.reserve.description;
            recorded.halfWidthDescription = this.reserve.halfWidthDescription;
            recorded.extended = this.reserve.extended;
            recorded.halfWidthExtended = this.reserve.halfWidthExtended;
            recorded.rawExtended = this.reserve.rawExtended;
            recorded.rawHalfWidthExtended = this.reserve.rawHalfWidthExtended;
            recorded.genre1 = this.reserve.genre1;
            recorded.subGenre1 = this.reserve.subGenre1;
            recorded.genre2 = this.reserve.genre2;
            recorded.subGenre2 = this.reserve.subGenre2;
            recorded.genre3 = this.reserve.genre3;
            recorded.subGenre3 = this.reserve.subGenre3;
            recorded.videoType = this.reserve.videoType;
            recorded.videoResolution = this.reserve.videoResolution;
            recorded.videoStreamContent = this.reserve.videoStreamContent;
            recorded.videoComponentType = this.reserve.videoComponentType;
            recorded.audioSamplingRate = this.reserve.audioSamplingRate;
            recorded.audioComponentType = this.reserve.audioComponentType;
        } else {
            // name が null
            throw new Error('CreateRecordedError');
        }

        if (this.dropLogFileId !== null) {
            recorded.dropLogFileId = this.dropLogFileId;
        }

        return recorded;
    }

    /**
     * 録画終了処理
     */
    private async recEnd(): Promise<void> {
        if (this.isRecEndStarted === true) {
            return;
        }
        this.isRecEndStarted = true;

        this.log.system.info(`start recEnd reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);

        // stream 停止
        this.destroyStream();

        // イベントリレーのチェック用タイマーをクリア
        if (this.eventRelayTimerId !== null) {
            clearTimeout(this.eventRelayTimerId);
        }

        // 削除予定か?
        if (this.isPlanToDelete === true) {
            this.log.system.info(`plan to delete reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);

            if (this.dropLogFileId !== null) {
                await this.dropChecker.stop().catch(err => {
                    this.log.system.error(`stop drop checker error: ${this.dropLogFileId}`);
                    this.log.system.error(err);
                });
            }

            await this.cleanupRealtimeEncodeFiles();

            return;
        }

        if (this.recordedId !== null) {
            // remove recording flag
            this.log.system.info(`remove recording flag: ${this.recordedId}`);
            await this.recordedDB.removeRecording(this.recordedId);
            this.isRecording = false;

            // tmp に録画していた場合は移動する
            if (typeof this.config.recordedTmp !== 'undefined' && this.videoFileId !== null) {
                try {
                    const newVdeoFileFulPath = await this.recordingUtil.movingFromTmp(this.reserve, this.videoFileId);
                    this.videoFileFulPath = newVdeoFileFulPath;
                } catch (err: any) {
                    this.log.system.fatal(`movingFromTmp error: ${this.videoFileId}`);
                    this.log.system.fatal(err);
                }
            }

            if (this.isRecordingFailed === true) {
                await this.cleanupRealtimeEncodeFiles();
            } else {
                await this.publishRealtimeEncode().catch(err => {
                    this.log.system.error(
                        `publish realtime encode failed reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`,
                    );
                    this.log.system.error(err);
                });
            }

            // update video file size
            if (this.videoFileId !== null && this.videoFileFulPath !== null) {
                this.recordingUtil.updateVideoFileSize(this.videoFileId).catch(err => {
                    this.log.system.error(`update file size error: ${this.videoFileId}`);
                    this.log.system.error(err);
                });
            }

            // drop 情報更新
            await this.updateDropFileLog().catch(err => {
                this.log.system.fatal(`updateDropFileLog error: ${this.dropLogFileId}`);
                this.log.stream.fatal(err);
            });

            // recorded 情報取得
            const recorded = await this.recordedDB.findId(this.recordedId);

            // Recorded history 追加
            if (
                this.reserve.isTimeSpecified === false &&
                this.reserve.ruleId !== null &&
                this.reserve.isEventRelay === false &&
                this.isNeedDeleteReservation === true
            ) {
                // ルール(Program Id 予約)の場合のみ記録する
                try {
                    if (recorded !== null) {
                        this.log.system.info(`add recorded history: ${this.recordedId}`);
                        const history = new RecordedHistory();
                        history.name = StrUtil.deleteBrackets(recorded.halfWidthName);
                        history.channelId = recorded.channelId;
                        history.endAt = recorded.endAt;
                        await this.recordedHistoryDB.insertOnce(history);
                    }
                } catch (err: any) {
                    this.log.system.error(`add recorded history error: ${this.recordedId}`);
                    this.log.system.error(err);
                }
            }

            // 録画完了の通知
            if (recorded !== null) {
                this.log.system.info(
                    `emit finish recording reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, isNeedDeleteReservation: ${this.isNeedDeleteReservation}`,
                );
                this.recordingEvent.emitFinishRecording(this.reserve, recorded, this.isNeedDeleteReservation);
            }
        } else {
            this.log.system.info('failed to recording: recorded id is null');
        }

        this.log.system.info(
            `recording finish reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, videoFileFulPath: ${this.videoFileFulPath}`,
        );
    }

    /**
     * drop log file 情報を更新する
     * @return Promise<void>
     */
    private async updateDropFileLog(): Promise<void> {
        if (this.dropLogFileId === null) {
            return;
        }

        // ドロップ情報カウント
        let error = 0;
        let drop = 0;
        let scrambling = 0;
        try {
            const dropResult = await this.dropChecker.getResult();
            for (const pid in dropResult) {
                error += dropResult[pid].error;
                drop += dropResult[pid].drop;
                scrambling += dropResult[pid].scrambling;
            }
        } catch (err: any) {
            this.log.system.error(`get drop result error: ${this.dropLogFileId}`);
            this.log.system.error(err);
            await this.dropChecker.stop().catch(() => {});

            return;
        }

        // ドロップ数をログに残す
        this.log.system.info({
            recordedId: this.recordedId,
            error: error,
            drop: drop,
            scrambling: scrambling,
        });

        // DB へ反映
        await this.dropLogFileDB
            .updateCnt({
                id: this.dropLogFileId,
                errorCnt: error,
                dropCnt: drop,
                scramblingCnt: scrambling,
            })
            .catch(err => {
                this.log.system.error(`update drop cnt error: ${this.dropLogFileId}`);
                this.log.system.error(err);
            });
    }

    /**
     * 予約のキャンセル
     */
    private async _cancel(): Promise<void> {
        if (this.isPrepRecording === false && this.isRecording === false) {
            // 録画処理が開始されていない
            if (this.timerId !== null) {
                clearTimeout(this.timerId);
            }
        } else if (this.isPrepRecording === true) {
            this.log.system.info(`cancel preprec: ${this.reserve.id}`);

            // 録画準備中
            return new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
                // タイムアウト設定
                const timerId = setTimeout(() => {
                    reject(new Error('PrepRecCancelTimeoutError'));
                }, 60 * 1000);

                // 録画準備中
                this.isStopPrepRec = true;
                if (this.abortController !== null) {
                    this.abortController.abort();
                }
                this.eventEmitter.once(RecorderModel.CANCEL_EVENT, () => {
                    clearTimeout(timerId);
                    // prep rec キャンセル完了
                    resolve();
                });
            });
        } else if (this.isRecording === true) {
            this.log.system.info(`stop recording: ${this.reserve.id}`);
            // 録画中
            if (this.stream !== null) {
                this.stream.destroy();
                this.stream.push(null); // eof 通知
            }
        }
    }

    /**
     * 予約のキャンセル
     * @param isPlanToDelete: boolean ファイルが削除される予定か
     */
    public async cancel(isPlanToDelete: boolean): Promise<void> {
        this.log.system.info(
            `recording cancel reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, isPlanToDelete: ${isPlanToDelete}`,
        );

        this.isPlanToDelete = isPlanToDelete;

        if (this.isPrepRecording === true) {
            await this._cancel();
            // 録画準備失敗を通知
            this.recordingEvent.emitCancelPrepRecording(this.reserve);
        } else if (this.isRecording === true) {
            await this._cancel();
            this.isNeedDeleteReservation = false;
        } else {
            await this._cancel();
        }
    }

    /**
     * 予約情報を更新する
     * @param newReserve: 新しい予約情報
     * @param isSuppressLog: boolean ログ出力を抑えるか
     */
    public async update(newReserve: Reserve, isSuppressLog: boolean): Promise<void> {
        if (newReserve.isSkip === true || newReserve.isOverlap === true) {
            // skip されたかチェック
            this.log.system.info(
                `cancel recording by skip or overlap reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`,
            );
            await this.cancel(false).catch(err => {
                this.log.system.error(`cancel recording error: ${newReserve.id}`);
                this.log.system.error(err);
            });
        } else if (this.reserve.startAt !== newReserve.startAt || this.reserve.endAt !== newReserve.endAt) {
            // 時刻に変更がないか確認
            // 録画処理が実行されていない場合
            if (this.isPrepRecording === false && this.isRecording === false) {
                this.setTimer(newReserve, isSuppressLog);
            } else {
                // 録画準備中 or 録画中
                if (this.reserve.programId === null) {
                    // 時間指定予約で時刻に変更があった
                    // TODO 現時点では時刻指定で時間変更を受け入れられるようにな api になっていない
                    // TODO 録画中 or 録画準備中の開始時刻変更にも対応していない
                    if (this.reserve.endAt !== newReserve.endAt) {
                        // 時間指定予約で終了時刻に変更があった
                        this.log.system.info(`change recording endAt: ${newReserve.id}`);

                        if (this.isPrepRecording === true) {
                            // 録画準備中なら録画中になるまで待つ
                            await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
                                this.log.system.debug(`wait change endAt: ${newReserve.id}`);
                                // タイムアウト設定
                                const timeoutId = setTimeout(() => {
                                    reject(new Error('ChangeEndAtTimeoutError'));
                                }, IRecordingStreamCreator.PREP_TIME);

                                // 録画開始内部イベント発行街
                                this.eventEmitter.once(RecorderModel.START_RECORDING_EVENT, () => {
                                    clearTimeout(timeoutId);
                                    resolve();
                                });
                            });
                        }

                        // 終了時刻変更
                        try {
                            this.streamCreator.changeEndAt(newReserve);
                        } catch (err: any) {
                            this.log.system.error(`change recording endAt: ${newReserve.id}`);
                            this.log.system.error(err);
                        }
                    }
                } else {
                    // 録画中に終了時間が変更されたらイベントリレーの確認タイマーも再設定する
                    if (this.reserve.endAt !== newReserve.endAt && this.isRecording === true) {
                        this.setEventRelayTimer(newReserve);
                        try {
                            this.streamCreator.changeEndAt(newReserve);
                        } catch (err: any) {
                            this.log.system.error(`change recording endAt: ${newReserve.id}`);
                            this.log.system.error(err);
                        }
                    }

                    if (this.reserve.startAt < newReserve.startAt) {
                        // 開始時刻が遅くなった
                        if (this.isRecording === false) {
                            // まだ録画準備中なのでキャンセルしてタイマーを再セット
                            this.log.system.info(
                                `cancel prepare recording.`,
                                `(reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}, recordedId: ${this.recordedId})`,
                            );
                            await this._cancel().catch(err => {
                                this.log.system.error(
                                    `cancel recording error: (reserveId: ${newReserve.id}, programId: ${this.reserve.programId})`,
                                );
                                this.log.system.error(err);
                            });
                            // NOTE: キャンセルエラーが発生したとしてもタイマーを再セット
                            this.setTimer(newReserve, isSuppressLog);
                        } else {
                            // 録画中
                            // NOTE:
                            //  EPGstationがスケジュール変更を遅れて把握した可能性がある
                            //  一度ストリームを開始した番組の開始時刻が変更されることはないのでここでは何もしない
                            this.log.system.info(
                                `Ignores schedule changes because this program is already recording.`,
                                ` (reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}, recordedId: ${this.recordedId})`,
                            );
                        }
                    }
                }
            }
        }

        this.reserve = newReserve;

        // update recorded DB
        if (this.isRecording === true && this.recordedId !== null) {
            const recorded = await this.createRecorded();
            this.log.system.info(`update reocrded: ${this.recordedId}`);
            this.recordedDB.updateOnce(recorded);
        }
    }

    /**
     * イベントリレーをチェックするためのタイマーをセットする
     * @param reserve: Reserve 予約情報
     */
    private setEventRelayTimer(reserve: Reserve): void {
        // 除外, 重複しているものはタイマーをセットしない
        if (reserve.isSkip === true || reserve.isOverlap === true) {
            return;
        }

        // 待機時間を計算
        const now = new Date().getTime();
        let time = reserve.endAt - RecorderModel.EVENT_RELAY_CHECK_TIME - now;
        if (time < 0) {
            time = 0;
        }

        // タイマーをセットする
        if (this.eventRelayTimerId !== null) {
            clearTimeout(this.eventRelayTimerId);
        }
        this.eventRelayTimerId = setTimeout(async () => {
            await this.checkEventRelay();
        }, time);
    }

    /**
     * イベントリレーの対象となる予約情報の確認を行う
     */
    private async checkEventRelay(): Promise<void> {
        // ProgramId の指定がない場合は何もしない
        if (this.reserve.programId === null) {
            return;
        }

        this.log.system.debug(
            `check event relay program. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
        );
        const mirakurun = this.mirakurunClientModel.getClient();

        // program 情報の取得
        let parentProgram: mapid.Program;
        try {
            parentProgram = await mirakurun.getProgram(this.reserve.programId);
            this.log.system.debug(parentProgram);
        } catch (err: any) {
            this.log.system.error(
                `failed to get event relay info. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
            );
            return;
        }

        // event relay の設定の有無を調べる
        if (typeof parentProgram.relatedItems === 'undefined') {
            this.log.system.debug(
                `event relay porgram does not exist. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
            );
            return;
        }

        // event relay 対象の ProgramId のリストを作成する
        const reserveProgramIds: { programId: apid.ProgramId; parentReserve: Reserve }[] = [];
        for (const relatedItem of parentProgram.relatedItems) {
            // type が ralay 出ないなら skip
            if (relatedItem.type !== 'relay') {
                continue;
            }

            // 番組を予約するための networkId を生成する
            let networkId = relatedItem.networkId;
            if (typeof networkId === 'undefined' || networkId === null) {
                // 本来 networkId は null を取らないはずだが、mirakc は null を返す
                // networkId が存在しない場合は自ネットワークのイベントリレーと判断する
                networkId = parentProgram.networkId;
            }

            // networkId, serviceId, eventId から該当する番組情報を検索する
            const reserveProgram = await this.programDB.findEventRelayProgram(
                networkId,
                relatedItem.serviceId,
                relatedItem.eventId,
            );
            if (reserveProgram === null) {
                this.log.system.warn(
                    `event relay program is not found. networkId: ${networkId}, serviceId: ${relatedItem.serviceId}, eventId: ${relatedItem.eventId}`,
                );
                continue;
            }

            // 予約に必要な情報を詰める
            // parentReserve は deep copy して渡す
            reserveProgramIds.push({ programId: reserveProgram.id, parentReserve: Object.assign({}, this.reserve) });
            this.log.system.info(
                `set event relay program. programId ${this.reserve.programId} -> ${reserveProgram.id}`,
            );
        }

        // イベントリレーの ProgramId が存在するなら予約を依頼する
        if (reserveProgramIds.length > 0) {
            this.recordingEvent.emitEventRelay(reserveProgramIds);
        }
    }

    /**
     * タイマーを再設定する
     * @return boolean セットに成功したら true を返す
     */
    public resetTimer(): boolean {
        // 録画中ならイベントリレーのチェック用のタイマーを再設定
        if (this.isRecording === true) {
            if (this.eventRelayTimerId !== null) {
                this.setEventRelayTimer(this.reserve);
            }
            return true;
        }

        return this.setTimer(this.reserve, false);
    }
}

namespace RecorderModel {
    export const CANCEL_EVENT = 'RecordingCancelEvent';
    export const START_RECORDING_EVENT = 'StartRecordingEvent';
    export const EVENT_RELAY_CHECK_TIME = 20 * 1000; // イベントリレーの確認時間 20秒
}

export default RecorderModel;
