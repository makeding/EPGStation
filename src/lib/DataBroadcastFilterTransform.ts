import * as fs from 'fs';
import * as stream from 'stream';
import ILogger from '../model/ILogger';

interface DataBroadcastFilterTransformOptions {
    logger?: ILogger;
    reserveId?: number;
    dataBroadcastPids?: Iterable<number>;
    pmtPids?: Iterable<number>;
    preserveDataBroadcastRanges?: ByteRange[];
}

interface CollectDataBroadcastPidsOptions {
    logger?: ILogger;
    reserveId?: number;
    sampleMode?: 'start' | 'threePoint';
}

interface DataBroadcastScanResult {
    dataBroadcastPids: Set<number>;
    pmtPids: Set<number>;
}

interface ByteRange {
    start: number;
    end: number;
}

interface PsiAssemblyState {
    data: Buffer;
    expectedLength: number | null;
    continuityCounter: number;
}

interface PmtAssemblyState extends PsiAssemblyState {
    packets: Buffer[];
    startOffset: number;
}

interface PmtOutputState {
    content: Buffer;
    version: number;
}

/**
 * Removes data-broadcast related streams from 188-byte MPEG-TS.
 */
export default class DataBroadcastFilterTransform extends stream.Transform {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly pmtPids: Set<number> = new Set();
    private readonly dataBroadcastPids: Set<number> = new Set();
    private readonly psiAssemblies: Map<number, PsiAssemblyState> = new Map();
    private readonly pmtAssemblies: Map<number, PmtAssemblyState> = new Map();
    private readonly pmtOutputContinuityCounters: Map<number, number> = new Map();
    private readonly pmtOutputStates: Map<number, PmtOutputState> = new Map();
    private readonly preserveDataBroadcastRanges: ByteRange[];
    private readonly logger?: ILogger;
    private readonly reserveId?: number;
    private processedPacketBytes: number = 0;
    private hasWarnedSync: boolean = false;
    private static crcTable: number[] | null = null;

    constructor(options: DataBroadcastFilterTransformOptions = {}) {
        super();
        this.logger = options.logger;
        this.reserveId = options.reserveId;
        this.preserveDataBroadcastRanges = options.preserveDataBroadcastRanges ?? [];
        if (typeof options.dataBroadcastPids !== 'undefined') {
            for (const pid of options.dataBroadcastPids) {
                this.dataBroadcastPids.add(pid);
            }
        }
        if (typeof options.pmtPids !== 'undefined') {
            for (const pid of options.pmtPids) {
                this.pmtPids.add(pid);
            }
        }
    }

    public static async collectDataBroadcastPidsFromFile(
        filePath: string,
        durationMs: number,
        options: CollectDataBroadcastPidsOptions = {},
    ): Promise<Set<number>> {
        const result = await DataBroadcastFilterTransform.collectDataBroadcastInfoFromFile(
            filePath,
            durationMs,
            options,
        );

        return result.dataBroadcastPids;
    }

    public static async collectDataBroadcastInfoFromFile(
        filePath: string,
        durationMs: number,
        options: CollectDataBroadcastPidsOptions = {},
    ): Promise<DataBroadcastScanResult> {
        const stat = await fs.promises.stat(filePath);
        if (stat.size < DataBroadcastFilterTransform.TS_PACKET_SIZE) {
            return { dataBroadcastPids: new Set(), pmtPids: new Set() };
        }

        const fd = await fs.promises.open(filePath, 'r');
        const detector = new DataBroadcastFilterTransform(options);
        detector.resume();
        const windows = DataBroadcastFilterTransform.createDataBroadcastPreserveRanges(
            stat.size,
            durationMs,
            options.sampleMode ?? 'threePoint',
        );
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

        return {
            dataBroadcastPids: new Set(detector.dataBroadcastPids),
            pmtPids: new Set(detector.pmtPids),
        };
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
            const packetOffset = this.processedPacketBytes;
            this.processedPacketBytes += DataBroadcastFilterTransform.TS_PACKET_SIZE;

            outputs.push(...this.processPacket(packet, packetOffset));
        }

        if (outputs.length > 0) {
            this.push(Buffer.concat(outputs));
        }

        callback();
    }

    private clearPendingBytes(): void {
        this.buffer = Buffer.alloc(0);
        this.psiAssemblies.clear();
        this.pmtAssemblies.clear();
        this.pmtOutputContinuityCounters.clear();
        this.pmtOutputStates.clear();
    }

    public _flush(callback: stream.TransformCallback): void {
        for (const pid of this.pmtAssemblies.keys()) {
            this.warn(`discarding incomplete PMT assembly for PID ${pid} at end of stream`);
        }
        this.pmtAssemblies.clear();

        if (this.buffer.length > 0) {
            this.push(this.buffer);
            this.buffer = Buffer.alloc(0);
        }
        callback();
    }

    private processPacket(packet: Buffer, packetOffset: number): Buffer[] {
        const pid = DataBroadcastFilterTransform.getPid(packet);
        if (this.dataBroadcastPids.has(pid) && this.shouldPreserveDataBroadcast(packetOffset) === false) {
            return [];
        }

        if (pid === DataBroadcastFilterTransform.PAT_PID) {
            for (const section of this.consumePsiPacket(pid, packet)) {
                this.parsePatSection(section);
            }
            return [packet];
        }

        if (this.pmtPids.has(pid)) {
            return this.processPmtPacket(pid, packet, packetOffset);
        }

        return [packet];
    }

    private parsePatSection(section: Buffer): void {
        if (section[0] !== DataBroadcastFilterTransform.PAT_TABLE_ID || section.length < 8) {
            return;
        }

        const sectionLength = DataBroadcastFilterTransform.getSectionLength(section);
        if (section.length !== 3 + sectionLength) {
            return;
        }

        const entriesEnd = 3 + sectionLength - DataBroadcastFilterTransform.CRC_SIZE;
        for (let pos = 8; pos + 4 <= entriesEnd; pos += 4) {
            const programNumber = (section[pos] << 8) | section[pos + 1];
            if (programNumber === 0) {
                continue;
            }

            const pmtPid = ((section[pos + 2] & 0x1f) << 8) | section[pos + 3];
            this.pmtPids.add(pmtPid);
        }
    }

    private processPmtPacket(pid: number, packet: Buffer, packetOffset: number): Buffer[] {
        const payloadOffset = DataBroadcastFilterTransform.getPayloadOffset(packet);
        if (payloadOffset === null || payloadOffset >= packet.length) {
            this.rememberPmtContinuityCounters(pid, [packet]);
            return [packet];
        }

        const continuityCounter = packet[3] & 0x0f;
        const isPayloadStart = (packet[1] & 0x40) !== 0;
        let state = this.pmtAssemblies.get(pid);
        const outputs: Buffer[] = [];

        if (isPayloadStart) {
            if (state !== undefined) {
                this.warn(`discarding incomplete PMT assembly for PID ${pid}`);
            }

            const pointer = packet[payloadOffset];
            const sectionOffset = payloadOffset + 1 + pointer;
            if (sectionOffset + 3 > packet.length || packet[sectionOffset] === 0xff) {
                this.pmtAssemblies.delete(pid);
                this.rememberPmtContinuityCounters(pid, [packet]);
                outputs.push(packet);
                return outputs;
            }

            const expectedLength = 3 + DataBroadcastFilterTransform.getSectionLength(packet.subarray(sectionOffset));
            state = {
                packets: [Buffer.from(packet)],
                data: Buffer.from(
                    packet.subarray(sectionOffset, Math.min(packet.length, sectionOffset + expectedLength)),
                ),
                expectedLength,
                continuityCounter,
                startOffset: packetOffset,
            };
            this.pmtAssemblies.set(pid, state);
        } else {
            if (state === undefined) {
                this.rememberPmtContinuityCounters(pid, [packet]);
                return [packet];
            }

            const expectedCounter = (state.continuityCounter + 1) & 0x0f;
            if (continuityCounter !== expectedCounter) {
                this.pmtAssemblies.delete(pid);
                this.warn(`PMT continuity counter mismatch for PID ${pid}`);
                return outputs;
            }

            const remaining = state.expectedLength === null ? packet.length : state.expectedLength - state.data.length;
            state.packets.push(Buffer.from(packet));
            state.data = Buffer.concat([state.data, packet.subarray(payloadOffset, payloadOffset + remaining)]);
            state.continuityCounter = continuityCounter;
        }

        if (state.expectedLength === null || state.data.length < state.expectedLength) {
            return outputs;
        }

        this.pmtAssemblies.delete(pid);
        const section = state.data.subarray(0, state.expectedLength);
        const outputSection = this.buildPmtSection(
            pid,
            section,
            this.shouldPreserveDataBroadcast(state.startOffset) === false,
        );
        if (outputSection === null) {
            this.rememberPmtContinuityCounters(pid, state.packets);
            outputs.push(...state.packets);
            return outputs;
        }

        outputs.push(...this.packetizePmt(pid, outputSection, state.packets[0][3] & 0x0f));
        return outputs;
    }

    private buildPmtSection(pid: number, section: Buffer, removeDataBroadcast: boolean): Buffer | null {
        if (section[0] !== DataBroadcastFilterTransform.PMT_TABLE_ID || section.length < 12) {
            return null;
        }

        const sectionLength = DataBroadcastFilterTransform.getSectionLength(section);
        if (section.length !== 3 + sectionLength) {
            return null;
        }

        const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
        const entriesStart = 12 + programInfoLength;
        const entriesEnd = 3 + sectionLength - DataBroadcastFilterTransform.CRC_SIZE;
        if (entriesStart > entriesEnd) {
            return null;
        }

        const entries: Buffer[] = [];
        let removed = false;
        for (let pos = entriesStart; pos < entriesEnd; ) {
            if (pos + 5 > entriesEnd) {
                return null;
            }

            const streamType = section[pos];
            const elementaryPid = ((section[pos + 1] & 0x1f) << 8) | section[pos + 2];
            const esInfoLength = ((section[pos + 3] & 0x0f) << 8) | section[pos + 4];
            const entryEnd = pos + 5 + esInfoLength;
            if (entryEnd > entriesEnd) {
                return null;
            }

            const isDataBroadcast =
                this.dataBroadcastPids.has(elementaryPid) ||
                DataBroadcastFilterTransform.isRemovableDataStream(streamType);
            if (isDataBroadcast) {
                this.dataBroadcastPids.add(elementaryPid);
                if (removeDataBroadcast === true) {
                    removed = true;
                }
            }

            if (isDataBroadcast === false || removeDataBroadcast === false) {
                entries.push(section.subarray(pos, entryEnd));
            }

            pos = entryEnd;
        }

        const newSectionWithoutCrc =
            removed === true
                ? Buffer.concat([section.subarray(0, entriesStart), ...entries])
                : Buffer.from(section.subarray(0, entriesEnd));
        const newSectionLength = newSectionWithoutCrc.length + DataBroadcastFilterTransform.CRC_SIZE - 3;
        newSectionWithoutCrc[1] = (newSectionWithoutCrc[1] & 0xf0) | ((newSectionLength >> 8) & 0x0f);
        newSectionWithoutCrc[2] = newSectionLength & 0xff;

        const content = Buffer.from(newSectionWithoutCrc);
        content[5] &= 0xc1;
        const previousState = this.pmtOutputStates.get(pid);
        const originalVersion = (section[5] >> 1) & 0x1f;
        const version =
            previousState === undefined
                ? originalVersion
                : previousState.content.equals(content)
                  ? previousState.version
                  : (previousState.version + 1) & 0x1f;
        newSectionWithoutCrc[5] = (newSectionWithoutCrc[5] & 0xc1) | (version << 1);
        this.pmtOutputStates.set(pid, { content, version });

        const crc = Buffer.alloc(DataBroadcastFilterTransform.CRC_SIZE);
        crc.writeUInt32BE(DataBroadcastFilterTransform.crc32Mpeg(newSectionWithoutCrc), 0);
        return Buffer.concat([newSectionWithoutCrc, crc]);
    }

    private consumePsiPacket(pid: number, packet: Buffer): Buffer[] {
        const payloadOffset = DataBroadcastFilterTransform.getPayloadOffset(packet);
        if (payloadOffset === null || payloadOffset >= packet.length) {
            return [];
        }

        const continuityCounter = packet[3] & 0x0f;
        const isPayloadStart = (packet[1] & 0x40) !== 0;
        const state = this.psiAssemblies.get(pid);
        if (isPayloadStart) {
            const pointer = packet[payloadOffset];
            const sectionOffset = payloadOffset + 1 + pointer;
            if (sectionOffset + 3 > packet.length || packet[sectionOffset] === 0xff) {
                this.psiAssemblies.delete(pid);
                return [];
            }

            const expectedLength = 3 + DataBroadcastFilterTransform.getSectionLength(packet.subarray(sectionOffset));
            const data = Buffer.from(
                packet.subarray(sectionOffset, Math.min(packet.length, sectionOffset + expectedLength)),
            );
            if (data.length >= expectedLength) {
                this.psiAssemblies.delete(pid);
                return [data.subarray(0, expectedLength)];
            }

            this.psiAssemblies.set(pid, { data, expectedLength, continuityCounter });
            return [];
        }

        if (state === undefined) {
            return [];
        }

        const expectedCounter = (state.continuityCounter + 1) & 0x0f;
        if (continuityCounter !== expectedCounter) {
            this.psiAssemblies.delete(pid);
            return [];
        }

        const remaining = state.expectedLength === null ? packet.length : state.expectedLength - state.data.length;
        state.data = Buffer.concat([state.data, packet.subarray(payloadOffset, payloadOffset + remaining)]);
        state.continuityCounter = continuityCounter;
        if (state.expectedLength !== null && state.data.length >= state.expectedLength) {
            this.psiAssemblies.delete(pid);
            return [state.data.subarray(0, state.expectedLength)];
        }

        return [];
    }

    private packetizePmt(pid: number, section: Buffer, initialCounter: number): Buffer[] {
        const packets: Buffer[] = [];
        let sectionOffset = 0;
        let counter = this.pmtOutputContinuityCounters.get(pid);

        while (sectionOffset < section.length) {
            counter = typeof counter === 'number' ? (counter + 1) & 0x0f : initialCounter;
            const packet = Buffer.alloc(DataBroadcastFilterTransform.TS_PACKET_SIZE, 0xff);
            const isFirst = sectionOffset === 0;
            packet[0] = DataBroadcastFilterTransform.SYNC_BYTE;
            packet[1] = ((pid >> 8) & 0x1f) | (isFirst ? 0x40 : 0x00);
            packet[2] = pid & 0xff;
            packet[3] = 0x10 | counter;

            let payloadOffset = 4;
            if (isFirst) {
                packet[payloadOffset++] = 0;
            }

            const copyLength = Math.min(packet.length - payloadOffset, section.length - sectionOffset);
            section.copy(packet, payloadOffset, sectionOffset, sectionOffset + copyLength);
            sectionOffset += copyLength;
            packets.push(packet);
        }

        if (typeof counter === 'number') {
            this.pmtOutputContinuityCounters.set(pid, counter);
        }
        return packets;
    }

    private rememberPmtContinuityCounters(pid: number, packets: Buffer[]): void {
        if (packets.length > 0) {
            this.pmtOutputContinuityCounters.set(pid, packets[packets.length - 1][3] & 0x0f);
        }
    }

    private shouldPreserveDataBroadcast(packetOffset: number): boolean {
        return this.preserveDataBroadcastRanges.some(range => packetOffset >= range.start && packetOffset < range.end);
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

    public static createDataBroadcastPreserveRanges(
        fileSize: number,
        durationMs: number,
        sampleMode: 'start' | 'threePoint',
    ): ByteRange[] {
        return sampleMode === 'start'
            ? DataBroadcastFilterTransform.createStartSampleWindow(fileSize, durationMs)
            : DataBroadcastFilterTransform.createThreePointSampleWindows(fileSize, durationMs);
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
