import { injectable } from 'inversify';
import * as log4js from 'log4js';
import ILogger from './ILogger';
import ILoggerModel from './ILoggerModel';

/**
 * Logger
 */
@injectable()
export default class LoggerModel implements ILoggerModel {
    private logger: ILogger | null = null;

    /**
     * 初期設定
     */
    public initialize(): void {
        log4js.configure({
            appenders: {
                console: { type: 'console' },
            },
            categories: {
                default: { appenders: ['console'], level: 'info' },
                system: { appenders: ['console'], level: 'info' },
                access: { appenders: ['console'], level: 'info' },
                stream: { appenders: ['console'], level: 'info' },
                encode: { appenders: ['console'], level: 'info' },
            },
        });

        // set Logger
        this.logger = {
            system: log4js.getLogger('system'),
            access: log4js.getLogger('access'),
            stream: log4js.getLogger('stream'),
            encode: log4js.getLogger('encode'),
        };
    }

    /**
     * Logger を返す
     * @return Logger
     */
    public getLogger(): ILogger {
        if (this.logger === null) {
            console.error('Logger is not initialized');
            process.exit(1);
        }

        return this.logger;
    }
}
