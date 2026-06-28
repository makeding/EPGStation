<template>
    <div class="live-mpegts-video">
        <video ref="video" autoplay playsinline></video>
        <div v-if="streamType === 'mmts'" ref="b62Overlay" class="b62-overlay"></div>
    </div>
</template>

<script lang="ts">
import BaseVideo from '@/components/video/BaseVideo';
import container from '@/model/ModelContainer';
import ISnackbarState from '@/model/state/snackbar/ISnackbarState';
import * as aribb24js from 'aribb24.js';
import { B62TTMLRenderer } from 'aribb62.js';
import { Component, Prop } from 'vue-property-decorator';
import Mmts from 'mmts.js';
import HLSUtil from '@/util/HLSUtil';
import { LiveMpegTsStreamType } from './ViedoParam';

@Component({})
export default class LiveMpegTsVideo extends BaseVideo {
    @Prop({ required: true })
    public videoSrc!: string;

    @Prop({ required: false, default: 'mse' })
    public streamType!: LiveMpegTsStreamType;

    private snackbarState: ISnackbarState = container.get<ISnackbarState>('ISnackbarState');
    private mmtsPlayer: Mpegts.Player | null = null;
    private captionRenderer: aribb24js.CanvasRenderer | null = null;
    private superimposeRenderer: aribb24js.CanvasRenderer | null = null;
    private b62Renderer: B62TTMLRenderer | null = null;

    public mounted(): void {
        super.mounted();
    }

    public async beforeDestroy(): Promise<void> {
        if (this.mmtsPlayer !== null) {
            this.mmtsPlayer.pause();
            this.mmtsPlayer.unload();
            this.mmtsPlayer.destroy();
            this.mmtsPlayer = null;
        }

        if (this.captionRenderer !== null) {
            this.captionRenderer.detachMedia();
            this.captionRenderer.dispose();
            this.captionRenderer = null;
        }

        if (this.superimposeRenderer !== null) {
            this.superimposeRenderer.detachMedia();
            this.superimposeRenderer.dispose();
            this.superimposeRenderer = null;
        }

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
        // 対応しているか確認
        if (Mmts.isSupported() === false || Mmts.getFeatureList().mseLivePlayback === false) {
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

        // mmts.js の設定
        Mmts.LoggingControl.enableVerbose = true;
        const mmtsConfig: Mpegts.Config = {
            enableWorker: true,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMinRemain: 1.0,
            liveBufferLatencyMaxLatency: 2.0,
        };
        this.mmtsPlayer = Mmts.createPlayer(
            {
                type: this.streamType,
                isLive: true,
                url: this.videoSrc,
            },
            mmtsConfig,
        );

        this.mmtsPlayer.attachMediaElement(this.video);
        this.mmtsPlayer.load();
        this.mmtsPlayer.play();

        if (this.streamType === 'mmts') {
            this.initB62Renderer();
            return;
        }

        // 字幕対応
        const captionOption = HLSUtil.getAribb24BaseOption();
        captionOption.data_identifer = 0x80;
        this.captionRenderer = new aribb24js.CanvasRenderer(captionOption);

        const superimposeOption = HLSUtil.getAribb24BaseOption();
        superimposeOption.data_identifer = 0x81;
        this.superimposeRenderer = new aribb24js.CanvasRenderer(superimposeOption);

        this.captionRenderer.attachMedia(this.video);
        this.superimposeRenderer.attachMedia(this.video);

        /**
         * 字幕スーパー用の処理
         * 元のソースは下記参照
         * https://twitter.com/magicxqq/status/1381813912539066373
         * https://github.com/l3tnun/EPGStation/commit/352bf9a69fdd0848295afb91859e1a402b623212#commitcomment-50407815
         */
        this.mmtsPlayer.on(Mmts.Events.PES_PRIVATE_DATA_ARRIVED, data => {
            if (data.stream_id === 0xbd && data.data[0] === 0x80 && this.captionRenderer !== null) {
                // private_stream_1, caption
                this.captionRenderer.pushData(data.pid, data.data, data.pts / 1000);
            } else if (data.stream_id === 0xbf && this.superimposeRenderer !== null) {
                // private_stream_2, superimpose
                let payload = data.data;
                if (payload[0] !== 0x81) {
                    payload = this.parseMalformedPES(data.data);
                }
                if (payload[0] !== 0x81) {
                    return;
                }
                this.superimposeRenderer.pushData(data.pid, payload, data.nearest_pts / 1000);
            }
        });
    }

    private initB62Renderer(): void {
        if (this.video === null) {
            return;
        }

        const overlay = this.$refs.b62Overlay as HTMLElement | undefined;
        this.b62Renderer = new B62TTMLRenderer({
            mediaElement: this.video,
            overlayElement: overlay,
            isLive: true,
        });

        if (this.mmtsPlayer !== null) {
            this.mmtsPlayer.on(Mmts.Events.MMTS_SUBTITLE_DATA_ARRIVED, data => {
                if (this.b62Renderer !== null) {
                    this.b62Renderer.push(data);
                }
            });
        }
    }

    /**
     * 字幕スーパー用の処理
     * 元のソースは下記参照
     * https://twitter.com/magicxqq/status/1381813912539066373
     * https://github.com/l3tnun/EPGStation/commit/352bf9a69fdd0848295afb91859e1a402b623212#commitcomment-50407815
     */
    private parseMalformedPES(data: any): any {
        let pes_scrambling_control = (data[0] & 0x30) >>> 4;
        let pts_dts_flags = (data[1] & 0xc0) >>> 6;
        let pes_header_data_length = data[2];

        let payload_start_index = 3 + pes_header_data_length;
        let payload_length = data.byteLength - payload_start_index;

        let payload = data.subarray(payload_start_index, payload_start_index + payload_length);

        return payload;
    }

    /**
     * 動画の長さを返す (秒)
     * @return number
     */
    public getDuration(): number {
        return 0;
    }

    /**
     * 動画の現在再生位置を返す (秒)
     * @return number
     */
    public getCurrentTime(): number {
        return 0;
    }

    /**
     * 再生位置設定
     * @param time: number (秒)
     */
    public setCurrentTime(time: number): void {
        return;
    }

    /**
     * 字幕を表示させる
     */
    public showSubtitle(): void {
        super.showSubtitle();
        this.lastSubtitleState = 'showing';
        if (this.captionRenderer !== null) {
            this.captionRenderer.show();
        }

        if (this.superimposeRenderer !== null) {
            this.superimposeRenderer.show();
        }

        if (this.b62Renderer !== null) {
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

        if (this.captionRenderer !== null) {
            this.captionRenderer.hide();
        }

        if (this.superimposeRenderer !== null) {
            this.superimposeRenderer.hide();
        }

        if (this.b62Renderer !== null) {
            this.b62Renderer.clear();
            this.b62Renderer.stopClock();
        }
    }

    /**
     * 字幕が有効か
     * @return boolean true で有効
     */
    public isEnabledSubtitles(): boolean {
        return this.captionRenderer !== null || this.superimposeRenderer !== null || this.b62Renderer !== null || super.isEnabledSubtitles();
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
