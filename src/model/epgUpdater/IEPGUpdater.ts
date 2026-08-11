export default interface IEPGUpdater {
    start(): Promise<void>;
    updateOnce(): Promise<void>;
}
