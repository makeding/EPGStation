import * as stream from 'stream';
import ILogger from '../model/ILogger';

interface DataBroadcastFilterTransformOptions {
    logger?: ILogger;
    reserveId?: number;
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
    private pendingPackets: Buffer[] | null = [];
    private pendingBytes: number = 0;
    private readonly pmtPids: Set<number> = new Set();
    private readonly dataBroadcastPids: Set<number> = new Set();
    private readonly logger?: ILogger;
    private readonly reserveId?: number;
    private hasWarnedSync: boolean = false;
    private hasParsedPmt: boolean = false;
    private static crcTable: number[] | null = null;

    constructor(options: DataBroadcastFilterTransformOptions = {}) {
        super();
        this.logger = options.logger;
        this.reserveId = options.reserveId;
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

            if (this.pendingPackets !== null) {
                this.pendingPackets.push(Buffer.from(packet));
                this.pendingBytes += packet.length;
                this.processPacket(packet);

                if (this.hasParsedPmt === true) {
                    outputs.push(...this.flushPendingPackets());
                } else if (this.pendingBytes >= DataBroadcastFilterTransform.MAX_PENDING_BYTES) {
                    this.warn('PMT was not found before startup buffer limit; flushing packets without initial filtering');
                    outputs.push(...this.flushPendingPackets());
                }

                continue;
            }

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

    public _flush(callback: stream.TransformCallback): void {
        if (this.pendingPackets !== null) {
            const outputs = this.flushPendingPackets();
            if (outputs.length > 0) {
                this.push(Buffer.concat(outputs));
            }
        }

        if (this.buffer.length > 0) {
            this.push(this.buffer);
            this.buffer = Buffer.alloc(0);
        }
        callback();
    }

    private flushPendingPackets(): Buffer[] {
        if (this.pendingPackets === null) {
            return [];
        }

        const pendingPackets = this.pendingPackets;
        this.pendingPackets = null;
        this.pendingBytes = 0;

        const outputs: Buffer[] = [];
        for (const packet of pendingPackets) {
            const processed = this.processPacket(packet);
            if (processed !== null) {
                outputs.push(processed);
            }
        }

        return outputs;
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
        this.hasParsedPmt = true;

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

            if (DataBroadcastFilterTransform.isRemovableDataStream(streamType, psi.section.subarray(pos + 5, entryEnd))) {
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

    private static isRemovableDataStream(streamType: number, esInfo: Buffer): boolean {
        if (streamType === DataBroadcastFilterTransform.TYPE_D_STREAM_TYPE) {
            return true;
        }

        if (streamType !== DataBroadcastFilterTransform.PES_PRIVATE_DATA_STREAM_TYPE) {
            return false;
        }

        const componentTag = DataBroadcastFilterTransform.getComponentTag(esInfo);

        return (
            componentTag === DataBroadcastFilterTransform.SUPERIMPOSE_COMPONENT_TAG ||
            componentTag === DataBroadcastFilterTransform.SUPERIMPOSE_1SEG_COMPONENT_TAG
        );
    }

    private static getComponentTag(esInfo: Buffer): number | null {
        for (let pos = 0; pos + 2 <= esInfo.length; ) {
            const tag = esInfo[pos];
            const length = esInfo[pos + 1];
            const descriptorEnd = pos + 2 + length;
            if (descriptorEnd > esInfo.length) {
                return null;
            }

            if (tag === DataBroadcastFilterTransform.STREAM_IDENTIFIER_DESCRIPTOR && length >= 1) {
                return esInfo[pos + 2];
            }

            pos = descriptorEnd;
        }

        return null;
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

    private static readonly TS_PACKET_SIZE = 188;
    private static readonly MAX_PENDING_BYTES = 64 * 1024 * 1024;
    private static readonly SYNC_BYTE = 0x47;
    private static readonly SYNC_CHECK_COUNT = 4;
    private static readonly PAT_PID = 0x0000;
    private static readonly PAT_TABLE_ID = 0x00;
    private static readonly PMT_TABLE_ID = 0x02;
    private static readonly PES_PRIVATE_DATA_STREAM_TYPE = 0x06;
    private static readonly TYPE_D_STREAM_TYPE = 0x0d;
    private static readonly STREAM_IDENTIFIER_DESCRIPTOR = 0x52;
    private static readonly SUPERIMPOSE_COMPONENT_TAG = 0x38;
    private static readonly SUPERIMPOSE_1SEG_COMPONENT_TAG = 0x88;
    private static readonly CRC_SIZE = 4;
}
