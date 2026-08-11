<template>
    <div class="live-mpegts-video">
        <video ref="video" autoplay playsinline></video>
        <div v-if="streamType === 'tlv'" ref="b62Overlay" class="b62-overlay"></div>
    </div>
</template>

<script lang="ts">
import BaseVideo from '@/components/video/BaseVideo';
import container from '@/model/ModelContainer';
import ISnackbarState from '@/model/state/snackbar/ISnackbarState';
import { B62TTMLRenderer } from 'aribb62.js';
import { Component, Prop } from 'vue-property-decorator';
import createTlvDemuxModule from 'tlvdemux';
import { MseAppendQueue } from 'tlvdemux/mse-append-queue';
import { LiveMpegTsStreamType } from './ViedoParam';

@Component({})
export default class LiveMpegTsVideo extends BaseVideo {
    @Prop({ required: true })
    public videoSrc!: string;

    @Prop({ required: false, default: 'tlv' })
    public streamType!: LiveMpegTsStreamType;

    @Prop({ required: false, default: true })
    public isLive!: boolean;

    private snackbarState: ISnackbarState = container.get<ISnackbarState>('ISnackbarState');
    private demuxer: any = null;
    private mediaSource: MediaSource | null = null;
    private mediaObjectUrl: string | null = null;
    private mediaQueues: MseAppendQueue[] = [];
    private streamAbortController: AbortController | null = null;
    private b62Renderer: B62TTMLRenderer | null = null;

    public mounted(): void {
        super.mounted();
    }

    public async beforeDestroy(): Promise<void> {
        this.streamAbortController?.abort();
        this.demuxer?.delete();
        this.demuxer = null;
        this.mediaQueues.forEach(queue => queue.destroy());
        this.mediaQueues = [];
        if (this.mediaObjectUrl !== null) URL.revokeObjectURL(this.mediaObjectUrl);
        this.mediaObjectUrl = null;
        this.mediaSource = null;

        if (this.b62Renderer !== null) {
            this.b62Renderer.destroy();
            this.b62Renderer = null;
        }

        super.beforeDestroy();
    }

    /**
     * video 再生初期設定
     */
    protected initVideoSetting(): void {
        const MediaSourceClass = window.ManagedMediaSource || window.MediaSource;
        if (this.streamType !== 'tlv' || typeof MediaSourceClass === 'undefined') {
            this.snackbarState.open({
                color: 'error',
                text: '非対応ブラウザーです。',
            });

            throw new Error('UnsupportedBrowser');
        }

        if (this.video === null) {
            this.snackbarState.open({
                color: 'error',
                text: 'video 要素がありません。',
            });
            throw new Error('VideoIsNull');
        }

        const mediaSource = new MediaSourceClass() as MediaSource;
        this.mediaSource = mediaSource;
        this.mediaObjectUrl = URL.createObjectURL(mediaSource);
        this.video.src = this.mediaObjectUrl;
        this.video.load();
        void this.startTlvStream(mediaSource);
    }

    private async startTlvStream(mediaSource: MediaSource): Promise<void> {
        if (mediaSource.readyState !== 'open') await new Promise<void>(resolve => mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }));
        const queues = new Map<string, MseAppendQueue>();
        const module = await createTlvDemuxModule();
        const appendInit = (init: any): void => {
            if (queues.has(init.type)) return;
            const queue = new MseAppendQueue(mediaSource, this.video!, init.mime);
            queues.set(init.type, queue);
            this.mediaQueues.push(queue);
            queue.append(init.data);
        };
        const demuxer = new module.TlvDemuxer({
            mseMaxAudioChannels: 6,
            onMseInit: appendInit,
            onMseSegment: (segment: any) => queues.get(segment.type)?.append(segment.data),
            onPlaybackAccessUnitView: (unit: any) => {
                if (unit.codec === 'ttml' && this.b62Renderer !== null) {
                    this.b62Renderer.push({
                        packetId: 0,
                        pts: (Number(unit.ptsValue) / unit.ptsTimescale) * 1000,
                        dts: (Number(unit.dtsValue) / unit.dtsTimescale) * 1000,
                        data: unit.data,
                        len: unit.data.byteLength,
                    });
                }
            },
        });
        this.demuxer = demuxer;
        demuxer.setMseOutputEnabled(true);
        demuxer.setSubtitlePassthroughEnabled(true);
        this.initB62Renderer();
        this.streamAbortController = new AbortController();
        const response = await fetch(this.videoSrc, { signal: this.streamAbortController.signal });
        if (!response.ok || response.body === null) throw new Error(`TLV stream failed: ${response.status}`);
        const reader = response.body.getReader();
        try {
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                if (!demuxer.push(result.value)) throw new Error('TLV demux failed');
            }
            demuxer.flush();
            if (mediaSource.readyState === 'open') mediaSource.endOfStream();
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') this.snackbarState.open({ color: 'error', text: 'TLV ストリームの再生に失敗しました。' });
        } finally {
            reader.releaseLock();
        }
    }

    private initB62Renderer(): void {
        if (this.video === null) {
            return;
        }

        const overlay = this.$refs.b62Overlay as HTMLElement | undefined;
        this.b62Renderer = new B62TTMLRenderer({
            mediaElement: this.video,
            overlayElement: overlay,
            isLive: this.isLive,
        });
    }

    /**
     * 動画の長さを返す (秒)
     * @return number
     */
    public getDuration(): number {
        return this.isLive === true ? 0 : super.getDuration();
    }

    /**
     * 動画の現在再生位置を返す (秒)
     * @return number
     */
    public getCurrentTime(): number {
        return this.isLive === true ? 0 : super.getCurrentTime();
    }

    /**
     * 再生位置設定
     * @param time: number (秒)
     */
    public setCurrentTime(time: number): void {
        if (this.isLive === false) {
            super.setCurrentTime(time);
        }
    }

    /**
     * 字幕を表示させる
     */
    public showSubtitle(): void {
        super.showSubtitle();
        this.lastSubtitleState = 'showing';
        if (this.b62Renderer !== null) {
            this.setB62OverlayVisible(true);
            this.b62Renderer.startClock();
            this.b62Renderer.render();
        }
    }

    /**
     * 字幕を非表示にする
     */
    public disabledSubtitle(): void {
        super.disabledSubtitle();
        this.lastSubtitleState = 'disabled';

        if (this.b62Renderer !== null) {
            this.setB62OverlayVisible(false);
            this.b62Renderer.stopClock();
        }
    }

    private setB62OverlayVisible(isVisible: boolean): void {
        const overlay = this.$refs.b62Overlay as HTMLElement | undefined;
        if (typeof overlay !== 'undefined') {
            overlay.style.display = isVisible ? '' : 'none';
        }
    }

    /**
     * 字幕が有効か
     * @return boolean true で有効
     */
    public isEnabledSubtitles(): boolean {
        return this.b62Renderer !== null || super.isEnabledSubtitles();
    }

    /**
     * 字幕が表示されているか
     * @return boolean true で表示
     */
    public isShowingSubtitle(): boolean {
        return this.isEnabledSubtitles() === true && this.lastSubtitleState === 'showing';
    }
}
</script>

<style lang="sass" scoped>
.live-mpegts-video
    position: relative
    width: 100%
    height: 100%

    video
        position: absolute
        top: 0
        left: 0
        width: 100%
        height: 100%

    .b62-overlay
        position: absolute
        top: 0
        left: 0
        width: 100%
        height: 100%
</style>
