import * as stream from 'stream';
import ILogger from '../model/ILogger';

export interface BufferedWriteStreamOptions {
    maxBufferSize: number; // 最大バッファサイズ (bytes)
    warningThreshold: number; // 警告閾値 (0-100 パーセント)
    logger: ILogger;
    reserveId: number; // ログ識別用
}

/**
 * BufferedWriteStream
 * 録画時の IO ピークを吸収するためのバッファ付き Transform ストリーム
 */
class BufferedWriteStream extends stream.Transform {
    private chunks: Buffer[] = [];
    private totalBuffered: number = 0;
    private maxBufferSize: number;
    private warningThreshold: number;
    private logger: ILogger;
    private reserveId: number;
    private hasWarnedHighUsage: boolean = false;
    private hasWarnedOverflow: boolean = false;
    private drainPending: boolean = false;
    private writeStream: stream.Writable | null = null;
    private isWriting: boolean = false;
    private lastLogTime: number = 0;
    private readonly LOG_INTERVAL: number = 5000; // 最大5秒ごとにログを記録

    constructor(options: BufferedWriteStreamOptions) {
        super({
            // 大きめの内部バッファを使用
            highWaterMark: 4 * 1024 * 1024, // 4MB 内部バッファ
        });

        this.maxBufferSize = options.maxBufferSize;
        this.warningThreshold = options.warningThreshold;
        this.logger = options.logger;
        this.reserveId = options.reserveId;
    }

    /**
     * 下流の WriteStream に接続する
     */
    public setWriteStream(ws: stream.Writable): void {
        this.writeStream = ws;

        ws.on('drain', () => {
            this.drainPending = false;
            this.flushBuffer();
        });

        ws.on('error', err => {
            this.emit('error', err);
        });
    }

    /**
     * Transform 実装
     */
    public _transform(chunk: Buffer, _encoding: string, callback: stream.TransformCallback): void {
        // バッファに追加
        this.chunks.push(chunk);
        this.totalBuffered += chunk.length;

        // バッファ状態をチェックして警告をログに記録
        this.checkBufferStatus();

        // バッファを書き込みストリームにフラッシュ
        this.flushBuffer();

        // 常に受信データを受け入れる（mirakurun にバックプレッシャーを伝播しない）
        callback();
    }

    /**
     * Flush 実装
     */
    public _flush(callback: stream.TransformCallback): void {
        // 残りのバッファをフラッシュ
        this.flushBuffer(true);
        callback();
    }

    /**
     * バッファ状態をチェックして警告を発行
     */
    private checkBufferStatus(): void {
        const usagePercent = (this.totalBuffered / this.maxBufferSize) * 100;
        const now = Date.now();

        // 閾値に達したら警告
        if (usagePercent >= this.warningThreshold && !this.hasWarnedHighUsage) {
            this.logger.system.warn(
                `Recording buffer high usage: ${usagePercent.toFixed(1)}% ` +
                    `(${this.formatBytes(this.totalBuffered)}/${this.formatBytes(this.maxBufferSize)}) ` +
                    `reserveId: ${this.reserveId}`,
            );
            this.hasWarnedHighUsage = true;
        } else if (usagePercent < this.warningThreshold - 10) {
            // 使用率が閾値 - 10% 以下に下がったら警告をリセット
            this.hasWarnedHighUsage = false;
        }

        // バッファオーバーフロー処理
        if (this.totalBuffered >= this.maxBufferSize) {
            if (!this.hasWarnedOverflow || now - this.lastLogTime > this.LOG_INTERVAL) {
                this.logger.system.error(
                    `Recording buffer overflow! Data may be lost. ` +
                        `Buffer: ${this.formatBytes(this.totalBuffered)}/${this.formatBytes(this.maxBufferSize)} ` +
                        `reserveId: ${this.reserveId}`,
                );
                this.hasWarnedOverflow = true;
                this.lastLogTime = now;
            }

            // 縮退策：古いデータを破棄してスペースを確保
            this.dropOldestChunks();
        }
    }

    /**
     * バッファを書き込みストリームにフラッシュ
     */
    private flushBuffer(_force: boolean = false): void {
        if (this.writeStream === null || this.drainPending || this.isWriting) {
            return;
        }

        this.isWriting = true;

        while (this.chunks.length > 0) {
            const chunk = this.chunks[0];
            const canWrite = this.writeStream.write(chunk);

            if (!canWrite) {
                this.drainPending = true;
                this.isWriting = false;

                return;
            }

            // 書き込み成功、バッファから削除
            this.chunks.shift();
            this.totalBuffered -= chunk.length;
        }

        this.isWriting = false;
    }

    /**
     * バッファオーバーフロー時に古いデータを破棄（縮退策）
     */
    private dropOldestChunks(): void {
        // 最大10%のバッファを破棄してスペースを確保
        const targetSize = this.maxBufferSize * 0.9;
        let droppedBytes = 0;

        while (this.totalBuffered > targetSize && this.chunks.length > 1) {
            const dropped = this.chunks.shift();
            if (dropped) {
                droppedBytes += dropped.length;
                this.totalBuffered -= dropped.length;
            }
        }

        if (droppedBytes > 0) {
            this.logger.system.error(
                `Dropped ${this.formatBytes(droppedBytes)} of recording data due to buffer overflow. ` +
                    `reserveId: ${this.reserveId}`,
            );
        }
    }

    /**
     * 現在のバッファ統計情報を取得
     */
    public getBufferStats(): { used: number; max: number; percentage: number } {
        return {
            used: this.totalBuffered,
            max: this.maxBufferSize,
            percentage: (this.totalBuffered / this.maxBufferSize) * 100,
        };
    }

    /**
     * バイトを人間が読める文字列にフォーマット
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';

        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * クリーンアップ
     */
    public destroy(error?: Error): this {
        this.chunks = [];
        this.totalBuffered = 0;
        this.writeStream = null;

        return super.destroy(error);
    }
}

export default BufferedWriteStream;
