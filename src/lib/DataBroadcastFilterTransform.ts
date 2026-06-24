import * as fs from 'fs';
import * as stream from 'stream';
import ILogger from '../model/ILogger';

interface DataBroadcastFilterTransformOptions {
    logger?: ILogger;
    reserveId?: number;
    dataBroadcastPids?: Iterable<number>;
}

interface CollectDataBroadcastPidsOptions {
    logger?: ILogger;
    reserveId?: number;
    sampleMode?: 'start' | 'threePoint';
}

interface PsiSection {
    payloadOffset: number;
    sectionOffset: number;
    section: Buffer;
}

/**
 * Removes data-broadcast related streams from 188-byte MPEG-TS.
 */
export default class DataBroadcastFilterTransform extends stream.Transform {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly pmtPids: Set<number> = new Set();
    private readonly dataBroadcastPids: Set<number> = new Set();
    private readonly logger?: ILogger;
    private readonly reserveId?: number;
    private hasWarnedSync: boolean = false;
    private static crcTable: number[] | null = null;

    constructor(options: DataBroadcastFilterTransformOptions = {}) {
        super();
        this.logger = options.logger;
        this.reserveId = options.reserveId;
        if (typeof options.dataBroadcastPids !== 'undefined') {
            for (const pid of options.dataBroadcastPids) {
                this.dataBroadcastPids.add(pid);
            }
        }
    }

    public static async collectDataBroadcastPidsFromFile(
        filePath: string,
        durationMs: number,
        options: CollectDataBroadcastPidsOptions = {},
    ): Promise<Set<number>> {
        const stat = await fs.promises.stat(filePath);
        if (stat.size < DataBroadcastFilterTransform.TS_PACKET_SIZE) {
            return new Set();
        }

        const fd = await fs.promises.open(filePath, 'r');
        const detector = new DataBroadcastFilterTransform(options);
        detector.resume();
        const windows =
            options.sampleMode === 'start'
                ? DataBroadcastFilterTransform.createStartSampleWindow(stat.size, durationMs)
                : DataBroadcastFilterTransform.createThreePointSampleWindows(stat.size, durationMs);
        const buffer = Buffer.alloc(DataBroadcastFilterTransform.SAMPLE_READ_SIZE);

        try {
            for (const window of windows) {
                let position = window.start;
                while (position < window.end) {
                    const readLength = Math.min(buffer.length, window.end - position);
                    const result = await fd.read(buffer, 0, readLength, position);
                    if (result.bytesRead === 0) {
                        break;
                    }

                    detector.write(buffer.subarray(0, result.bytesRead));
                    position += result.bytesRead;
                }

                detector.clearPendingBytes();
            }
        } finally {
            await fd.close();
        }

        return new Set(detector.dataBroadcastPids);
    }

    public _transform(chunk: Buffer, _encoding: string, callback: stream.TransformCallback): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const outputs: Buffer[] = [];

        while (this.buffer.length >= DataBroadcastFilterTransform.TS_PACKET_SIZE) {
            if (this.buffer[0] !== DataBroadcastFilterTransform.SYNC_BYTE) {
                const syncOffset = this.findSyncOffset(this.buffer);
                if (syncOffset === -1) {
                    outputs.push(this.buffer);
                    this.buffer = Buffer.alloc(0);
                    this.warnSyncLoss();
                    break;
                }

                if (syncOffset > 0) {
                    outputs.push(this.buffer.subarray(0, syncOffset));
                    this.buffer = this.buffer.subarray(syncOffset);
                    this.warnSyncLoss();
                }

                if (this.buffer.length < DataBroadcastFilterTransform.TS_PACKET_SIZE) {
                    break;
                }
            }

            const packet = this.buffer.subarray(0, DataBroadcastFilterTransform.TS_PACKET_SIZE);
            this.buffer = this.buffer.subarray(DataBroadcastFilterTransform.TS_PACKET_SIZE);

            const processed = this.processPacket(packet);
            if (processed !== null) {
                outputs.push(processed);
            }
        }

        if (outputs.length > 0) {
            this.push(Buffer.concat(outputs));
        }

        callback();
    }

    private clearPendingBytes(): void {
        this.buffer = Buffer.alloc(0);
    }

    public _flush(callback: stream.TransformCallback): void {
        if (this.buffer.length > 0) {
            this.push(this.buffer);
            this.buffer = Buffer.alloc(0);
        }
        callback();
    }

    private processPacket(packet: Buffer): Buffer | null {
        const pid = DataBroadcastFilterTransform.getPid(packet);
        if (this.dataBroadcastPids.has(pid)) {
            return null;
        }

        if (pid === DataBroadcastFilterTransform.PAT_PID) {
            this.parsePat(packet);
            return packet;
        }

        if (this.pmtPids.has(pid)) {
            return this.rewritePmt(packet);
        }

        return packet;
    }

    private parsePat(packet: Buffer): void {
        const psi = this.getPsiSection(packet);
        if (psi === null || psi.section[0] !== DataBroadcastFilterTransform.PAT_TABLE_ID) {
            return;
        }

        const sectionLength = DataBroadcastFilterTransform.getSectionLength(psi.section);
        const entriesEnd = 3 + sectionLength - DataBroadcastFilterTransform.CRC_SIZE;
        for (let pos = 8; pos + 4 <= entriesEnd; pos += 4) {
            const programNumber = (psi.section[pos] << 8) | psi.section[pos + 1];
            if (programNumber === 0) {
                continue;
            }

            const pmtPid = ((psi.section[pos + 2] & 0x1f) << 8) | psi.section[pos + 3];
            this.pmtPids.add(pmtPid);
        }
    }

    private rewritePmt(packet: Buffer): Buffer {
        const psi = this.getPsiSection(packet);
        if (psi === null || psi.section[0] !== DataBroadcastFilterTransform.PMT_TABLE_ID) {
            return packet;
        }

        const sectionLength = DataBroadcastFilterTransform.getSectionLength(psi.section);
        if (psi.section.length < 12 || psi.section.length !== 3 + sectionLength) {
            return packet;
        }

        const programInfoLength = ((psi.section[10] & 0x0f) << 8) | psi.section[11];
        const entriesStart = 12 + programInfoLength;
        const entriesEnd = 3 + sectionLength - DataBroadcastFilterTransform.CRC_SIZE;
        if (entriesStart > entriesEnd) {
            return packet;
        }

        const entries: Buffer[] = [];
        let removed = false;
        for (let pos = entriesStart; pos < entriesEnd; ) {
            if (pos + 5 > entriesEnd) {
                return packet;
            }

            const streamType = psi.section[pos];
            const elementaryPid = ((psi.section[pos + 1] & 0x1f) << 8) | psi.section[pos + 2];
            const esInfoLength = ((psi.section[pos + 3] & 0x0f) << 8) | psi.section[pos + 4];
            const entryEnd = pos + 5 + esInfoLength;
            if (entryEnd > entriesEnd) {
                return packet;
            }

            if (
                this.dataBroadcastPids.has(elementaryPid) ||
                DataBroadcastFilterTransform.isRemovableDataStream(streamType)
            ) {
                this.dataBroadcastPids.add(elementaryPid);
                removed = true;
            } else {
                entries.push(psi.section.subarray(pos, entryEnd));
            }

            pos = entryEnd;
        }

        if (removed === false) {
            return packet;
        }

        const newSectionWithoutCrc = Buffer.concat([psi.section.subarray(0, entriesStart), ...entries]);
        const newSectionLength = newSectionWithoutCrc.length + DataBroadcastFilterTransform.CRC_SIZE - 3;
        newSectionWithoutCrc[1] = (newSectionWithoutCrc[1] & 0xf0) | ((newSectionLength >> 8) & 0x0f);
        newSectionWithoutCrc[2] = newSectionLength & 0xff;

        const crc = Buffer.alloc(DataBroadcastFilterTransform.CRC_SIZE);
        crc.writeUInt32BE(DataBroadcastFilterTransform.crc32Mpeg(newSectionWithoutCrc), 0);
        const newSection = Buffer.concat([newSectionWithoutCrc, crc]);

        const packetPayloadPrefixSize = psi.sectionOffset - psi.payloadOffset;
        const payloadCapacity = DataBroadcastFilterTransform.TS_PACKET_SIZE - psi.payloadOffset;
        if (packetPayloadPrefixSize + newSection.length > payloadCapacity) {
            this.warn(`failed to rewrite PMT because rewritten section is too large`);
            return packet;
        }

        const rewritten = Buffer.from(packet);
        rewritten.fill(0xff, psi.payloadOffset);
        packet.copy(rewritten, psi.payloadOffset, psi.payloadOffset, psi.sectionOffset);
        newSection.copy(rewritten, psi.sectionOffset);

        return rewritten;
    }

    private getPsiSection(packet: Buffer): PsiSection | null {
        if ((packet[1] & 0x40) === 0) {
            return null;
        }

        const payloadOffset = DataBroadcastFilterTransform.getPayloadOffset(packet);
        if (payloadOffset === null || payloadOffset >= packet.length) {
            return null;
        }

        const pointer = packet[payloadOffset];
        const sectionOffset = payloadOffset + 1 + pointer;
        if (sectionOffset + 3 > packet.length) {
            return null;
        }

        const sectionLength = ((packet[sectionOffset + 1] & 0x0f) << 8) | packet[sectionOffset + 2];
        const sectionEnd = sectionOffset + 3 + sectionLength;
        if (sectionEnd > packet.length) {
            return null;
        }

        return {
            payloadOffset,
            sectionOffset,
            section: packet.subarray(sectionOffset, sectionEnd),
        };
    }

    private static getPayloadOffset(packet: Buffer): number | null {
        const adaptationFieldControl = (packet[3] >> 4) & 0x03;
        if (adaptationFieldControl === 0 || adaptationFieldControl === 2) {
            return null;
        }

        if (adaptationFieldControl === 1) {
            return 4;
        }

        const adaptationFieldLength = packet[4];
        const payloadOffset = 5 + adaptationFieldLength;
        return payloadOffset <= DataBroadcastFilterTransform.TS_PACKET_SIZE ? payloadOffset : null;
    }

    private findSyncOffset(buffer: Buffer): number {
        for (let offset = 1; offset < buffer.length; offset++) {
            let matchCount = 0;
            for (
                let pos = offset;
                pos < buffer.length && matchCount < DataBroadcastFilterTransform.SYNC_CHECK_COUNT;
                pos += DataBroadcastFilterTransform.TS_PACKET_SIZE
            ) {
                if (buffer[pos] !== DataBroadcastFilterTransform.SYNC_BYTE) {
                    break;
                }
                matchCount++;
            }

            if (matchCount >= 2) {
                return offset;
            }
        }

        return -1;
    }

    private warnSyncLoss(): void {
        if (this.hasWarnedSync === true) {
            return;
        }
        this.hasWarnedSync = true;
        this.warn('MPEG-TS sync byte loss detected; passing unsynchronized bytes through');
    }

    private warn(message: string): void {
        const suffix = typeof this.reserveId === 'number' ? ` reserveId: ${this.reserveId}` : '';
        this.logger?.system.warn(`DataBroadcastFilterTransform: ${message}.${suffix}`);
    }

    private static getPid(packet: Buffer): number {
        return ((packet[1] & 0x1f) << 8) | packet[2];
    }

    private static getSectionLength(section: Buffer): number {
        return ((section[1] & 0x0f) << 8) | section[2];
    }

    private static isRemovableDataStream(streamType: number): boolean {
        return streamType === DataBroadcastFilterTransform.TYPE_D_STREAM_TYPE;
    }

    private static crc32Mpeg(data: Buffer): number {
        if (DataBroadcastFilterTransform.crcTable === null) {
            DataBroadcastFilterTransform.crcTable = DataBroadcastFilterTransform.createCrcTable();
        }

        let crc = 0xffffffff;
        for (const byte of data) {
            crc = ((crc << 8) ^ DataBroadcastFilterTransform.crcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
        }

        return crc >>> 0;
    }

    private static createCrcTable(): number[] {
        const table: number[] = [];
        for (let i = 0; i < 256; i++) {
            let crc = i << 24;
            for (let j = 0; j < 8; j++) {
                crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
            }
            table[i] = crc >>> 0;
        }

        return table;
    }

    private static createStartSampleWindow(fileSize: number, durationMs: number): { start: number; end: number }[] {
        if (durationMs <= 0) {
            return [{ start: 0, end: Math.min(fileSize, DataBroadcastFilterTransform.START_ONLY_SAMPLE_BYTES) }];
        }

        const durationSec = durationMs / 1000;
        const end = DataBroadcastFilterTransform.alignPacketOffset(
            Math.ceil((fileSize * Math.min(60, durationSec)) / durationSec),
        );

        return [{ start: 0, end: Math.min(fileSize, Math.max(DataBroadcastFilterTransform.TS_PACKET_SIZE, end)) }];
    }

    private static createThreePointSampleWindows(
        fileSize: number,
        durationMs: number,
    ): { start: number; end: number }[] {
        if (durationMs <= 0) {
            return DataBroadcastFilterTransform.createStartSampleWindow(fileSize, durationMs);
        }

        const durationSec = durationMs / 1000;
        const startWindow = { startSec: 0, endSec: Math.min(60, durationSec) };
        const middleSec = durationSec / 2;
        const middleWindow = {
            startSec: Math.max(0, middleSec - 30),
            endSec: Math.min(durationSec, middleSec + 30),
        };
        const endWindow = { startSec: Math.max(0, durationSec - 60), endSec: durationSec };

        return [startWindow, middleWindow, endWindow]
            .map(window => {
                const start = DataBroadcastFilterTransform.alignPacketOffset(
                    Math.floor((fileSize * window.startSec) / durationSec),
                );
                const end = DataBroadcastFilterTransform.alignPacketOffset(
                    Math.ceil((fileSize * window.endSec) / durationSec),
                );

                return {
                    start,
                    end: Math.min(fileSize, Math.max(start, end)),
                };
            })
            .filter(window => window.end > window.start);
    }

    private static alignPacketOffset(offset: number): number {
        return offset - (offset % DataBroadcastFilterTransform.TS_PACKET_SIZE);
    }

    private static readonly TS_PACKET_SIZE = 188;
    private static readonly SAMPLE_READ_SIZE = 1024 * 1024;
    private static readonly START_ONLY_SAMPLE_BYTES = 64 * 1024 * 1024;
    private static readonly SYNC_BYTE = 0x47;
    private static readonly SYNC_CHECK_COUNT = 4;
    private static readonly PAT_PID = 0x0000;
    private static readonly PAT_TABLE_ID = 0x00;
    private static readonly PMT_TABLE_ID = 0x02;
    private static readonly TYPE_D_STREAM_TYPE = 0x0d;
    private static readonly CRC_SIZE = 4;
}
