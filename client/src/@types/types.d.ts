declare module 'resize-observer-polyfill';
declare module 'vuetify-datetime-picker';

declare module 'aribb24.js' {
    export interface CanvasRendererOption {
        [key: string]: any;
    }

    export class CanvasRenderer {
        constructor(option?: CanvasRendererOption);
        attachMedia(media: HTMLMediaElement): void;
        detachMedia(): void;
        dispose(): void;
        pushData(pid: number, data: Uint8Array, pts: number): void;
        pushID3v2Data(pts: number, data: Uint8Array): void;
        show(): void;
        hide(): void;
    }
}
