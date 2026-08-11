import { CanvasMainThreadRenderer, Controller, HLSFeeder } from 'aribb24.js';
import Hls from 'hls.js';
import { injectable } from 'inversify';
import HLSUtil from '../../../../util/HLSUtil';
import IB24RenderState from './IB24RenderState';

@injectable()
export default class B24RenderState implements IB24RenderState {
    private controller: Controller | null = null;
    private feeder: HLSFeeder | null = null;
    private renderer: CanvasMainThreadRenderer | null = null;
    private hls: Hls | null = null;
    private readonly onMetadata = (_event: string, data: any): void => {
        for (const sample of data.samples) {
            this.feeder?.feedID3(sample.data, sample.pts, sample.dts);
        }
    };

    /**
     * set b24 subtitle render
     * @param video: HTMLVideoElement
     * @param hls: Hls
     */
    public init(video: HTMLVideoElement, hls?: Hls): void {
        this.destroy();

        this.controller = new Controller();
        this.feeder = new HLSFeeder({
            recieve: {},
            tokenizer: {},
            offset: {},
        });
        this.renderer = new CanvasMainThreadRenderer(HLSUtil.getAribb24RendererOption());
        this.controller.attachFeeder(this.feeder);
        this.controller.attachRenderer(this.renderer);
        this.controller.attachMedia(video);

        if (typeof hls !== 'undefined') {
            this.hls = hls;
            hls.on(Hls.Events.FRAG_PARSING_METADATA, this.onMetadata);
        }
    }

    /**
     * destory b24 subtitle render
     */
    public destroy(): void {
        if (this.controller === null || this.feeder === null || this.renderer === null) {
            return;
        }

        if (this.hls !== null) {
            this.hls.off(Hls.Events.FRAG_PARSING_METADATA, this.onMetadata);
            this.hls = null;
        }
        this.controller.detachMedia();
        this.controller.detachFeeder();
        this.controller.detachRenderer(this.renderer);
        this.feeder.destroy();
        this.renderer.destroy();
        this.controller = null;
        this.feeder = null;
        this.renderer = null;
    }

    /**
     * 初期化済みか
     * @return boolean true で初期化済み
     */
    public isInited(): boolean {
        return this.controller !== null;
    }

    /**
     * 字幕を表示させる
     */
    public showSubtitle(): void {
        this.controller?.show();
    }

    /**
     * 字幕を非表示にする
     */
    public disabledSubtitle(): void {
        this.controller?.hide();
    }
}
