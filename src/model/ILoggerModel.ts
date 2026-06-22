import ILogger from './ILogger';

export default interface ILoggerModel {
    initialize(): void;
    getLogger(): ILogger;
}
