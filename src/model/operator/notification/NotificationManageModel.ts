import axios, { AxiosError } from 'axios';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import Recorded from '../../../db/entities/Recorded';
import IVideoUtil from '../../api/video/IVideoUtil';
import IChannelDB from '../../db/IChannelDB';
import IConfigFile, {
    NotificationEvent,
    NotificationTelegramConfig,
    NotificationTrigger,
    NotificationWebhookConfig,
} from '../../IConfigFile';
import IConfiguration from '../../IConfiguration';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import { IPromiseQueue } from '../../IPromiseQueue';
import INotificationManageModel from './INotificationManageModel';

type TemplateValue = string | number | boolean | null;

interface NotificationContext {
    event: NotificationEvent;
    values: { [key: string]: TemplateValue };
    payload: {
        event: NotificationEvent;
        recorded: {
            id: number;
            reserveId: number | null;
            ruleId: number | null;
            programId: number | null;
            channelId: number;
            channelType: string | null;
            channelName: string | null;
            halfWidthChannelName: string | null;
            startAt: number;
            endAt: number;
            duration: number;
            name: string;
            halfWidthName: string;
            description: string | null;
            halfWidthDescription: string | null;
            extended: string | null;
            halfWidthExtended: string | null;
            recPath: string | null;
            recRelativePath: string | null;
            recParentDirectoryName: string | null;
            logPath: string | null;
            errorCnt: number | null;
            dropCnt: number | null;
            scramblingCnt: number | null;
        };
        videoFile: {
            id: number;
            parentDirectoryName: string;
            filePath: string;
            name: string;
            type: string;
            size: number;
        } | null;
    };
}

@injectable()
export default class NotificationManageModel implements INotificationManageModel {
    private log: ILogger;
    private config: IConfigFile;
    private queue: IPromiseQueue;
    private channelDB: IChannelDB;
    private videoUtil: IVideoUtil;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IConfiguration') configuration: IConfiguration,
        @inject('IPromiseQueue') queue: IPromiseQueue,
        @inject('IChannelDB') channelDB: IChannelDB,
        @inject('IVideoUtil') videoUtil: IVideoUtil,
    ) {
        this.log = logger.getLogger();
        this.config = configuration.getConfig();
        this.queue = queue;
        this.channelDB = channelDB;
        this.videoUtil = videoUtil;
    }

    public addRecordingStart(recorded: Recorded): void {
        this.addRecorded('recordingStart', recorded);
    }

    public addRecordingFinish(recorded: Recorded): void {
        this.addRecorded('recordingFinish', recorded);
    }

    public addRecordingFailed(recorded: Recorded): void {
        this.addRecorded('recordingFailed', recorded);
    }

    private addRecorded(event: NotificationEvent, recorded: Recorded): void {
        if (this.isEnabled(event) === false) {
            return;
        }

        this.queue.add<void>(() => {
            return this.notify(event, recorded).catch(err => {
                this.log.system.error(`notification error: ${event}`);
                this.log.system.error(err);
            });
        });
    }

    private isEnabled(event: NotificationEvent): boolean {
        const notification = this.config.notification;
        if (typeof notification === 'undefined') {
            return false;
        }

        const telegrams = notification.telegram ?? [];
        const webhooks = notification.webhooks ?? [];

        return (
            telegrams.some(telegram => this.matchTrigger(telegram.trigger, event)) ||
            webhooks.some(webhook => this.matchTrigger(webhook.trigger, event))
        );
    }

    private async notify(event: NotificationEvent, recorded: Recorded): Promise<void> {
        const context = await this.createContext(event, recorded);
        const tasks: Promise<void>[] = [];

        if (typeof this.config.notification?.telegram !== 'undefined') {
            for (const telegram of this.config.notification.telegram) {
                if (this.matchTrigger(telegram.trigger, event)) {
                    tasks.push(this.sendTelegram(telegram, context));
                }
            }
        }

        if (typeof this.config.notification?.webhooks !== 'undefined') {
            for (const webhook of this.config.notification.webhooks) {
                if (this.matchTrigger(webhook.trigger, event)) {
                    tasks.push(this.sendWebhook(webhook, context));
                }
            }
        }

        await Promise.all(tasks);
    }

    private matchTrigger(trigger: NotificationTrigger, event: NotificationEvent): boolean {
        if (Array.isArray(trigger) === true) {
            return trigger.includes(event);
        }

        return trigger === event;
    }

    private async createContext(event: NotificationEvent, recorded: Recorded): Promise<NotificationContext> {
        const channel = await this.channelDB.findId(recorded.channelId);
        const videoFile =
            typeof recorded.videoFiles !== 'undefined' && recorded.videoFiles.length > 0
                ? recorded.videoFiles[0]
                : null;
        const recPath = videoFile === null ? null : await this.videoUtil.getFullFilePathFromId(videoFile.id);
        const recRelativePath = videoFile === null ? null : videoFile.filePath;
        const recParentDirectoryName = videoFile === null ? null : videoFile.parentDirectoryName;
        const logPath =
            typeof recorded.dropLogFile === 'undefined' || recorded.dropLogFile === null
                ? null
                : path.join(this.config.dropLog, recorded.dropLogFile.filePath);
        const channelType = channel === null ? null : channel.channelType;
        const channelName = channel === null ? null : channel.name;
        const halfWidthChannelName = channel === null ? null : channel.halfWidthName;
        const description = typeof recorded.description === 'undefined' ? null : recorded.description;
        const halfWidthDescription =
            typeof recorded.halfWidthDescription === 'undefined' ? null : recorded.halfWidthDescription;
        const extended = typeof recorded.extended === 'undefined' ? null : recorded.extended;
        const halfWidthExtended = typeof recorded.halfWidthExtended === 'undefined' ? null : recorded.halfWidthExtended;
        const errorCnt = recorded.dropLogFile?.errorCnt ?? null;
        const dropCnt = recorded.dropLogFile?.dropCnt ?? null;
        const scramblingCnt = recorded.dropLogFile?.scramblingCnt ?? null;

        const values: { [key: string]: TemplateValue } = {
            EVENT: event,
            RECORDEDID: recorded.id,
            RESERVEID: recorded.reserveId,
            RULEID: recorded.ruleId ?? null,
            PROGRAMID: recorded.programId,
            CHANNELTYPE: channelType,
            CHANNELID: recorded.channelId,
            CHANNELNAME: channelName,
            HALF_WIDTH_CHANNELNAME: halfWidthChannelName,
            STARTAT: recorded.startAt,
            ENDAT: recorded.endAt,
            DURATION: recorded.duration,
            NAME: recorded.name,
            HALF_WIDTH_NAME: recorded.halfWidthName,
            DESCRIPTION: description,
            HALF_WIDTH_DESCRIPTION: halfWidthDescription,
            EXTENDED: extended,
            HALF_WIDTH_EXTENDED: halfWidthExtended,
            RECPATH: recPath,
            REC_RELATIVE_PATH: recRelativePath,
            REC_PARENT_DIRECTORY_NAME: recParentDirectoryName,
            LOGPATH: logPath,
            ERROR_CNT: errorCnt,
            DROP_CNT: dropCnt,
            SCRAMBLING_CNT: scramblingCnt,
            VIDEOFILEID: videoFile === null ? null : videoFile.id,
            VIDEOFILENAME: videoFile === null ? null : videoFile.name,
            VIDEOFILETYPE: videoFile === null ? null : videoFile.type,
            VIDEOFILESIZE: videoFile === null ? null : videoFile.size,
            event,
            recordedId: recorded.id,
            reserveId: recorded.reserveId,
            ruleId: recorded.ruleId ?? null,
            programId: recorded.programId,
            channelType,
            channelId: recorded.channelId,
            channelName,
            halfWidthChannelName,
            startAt: recorded.startAt,
            endAt: recorded.endAt,
            duration: recorded.duration,
            name: recorded.name,
            halfWidthName: recorded.halfWidthName,
            description,
            halfWidthDescription,
            extended,
            halfWidthExtended,
            recPath,
            recRelativePath,
            recParentDirectoryName,
            logPath,
            errorCnt,
            dropCnt,
            scramblingCnt,
            videoFileId: videoFile === null ? null : videoFile.id,
            videoFileName: videoFile === null ? null : videoFile.name,
            videoFileType: videoFile === null ? null : videoFile.type,
            videoFileSize: videoFile === null ? null : videoFile.size,
        };

        return {
            event,
            values,
            payload: {
                event,
                recorded: {
                    id: recorded.id,
                    reserveId: recorded.reserveId,
                    ruleId: recorded.ruleId ?? null,
                    programId: recorded.programId,
                    channelId: recorded.channelId,
                    channelType,
                    channelName,
                    halfWidthChannelName,
                    startAt: recorded.startAt,
                    endAt: recorded.endAt,
                    duration: recorded.duration,
                    name: recorded.name,
                    halfWidthName: recorded.halfWidthName,
                    description,
                    halfWidthDescription,
                    extended,
                    halfWidthExtended,
                    recPath,
                    recRelativePath,
                    recParentDirectoryName,
                    logPath,
                    errorCnt,
                    dropCnt,
                    scramblingCnt,
                },
                videoFile:
                    videoFile === null
                        ? null
                        : {
                              id: videoFile.id,
                              parentDirectoryName: videoFile.parentDirectoryName,
                              filePath: videoFile.filePath,
                              name: videoFile.name,
                              type: videoFile.type,
                              size: videoFile.size,
                          },
            },
        };
    }

    private async sendTelegram(telegram: NotificationTelegramConfig, context: NotificationContext): Promise<void> {
        const telegramName = telegram.name ?? 'unnamed';
        const text =
            typeof telegram.messageTemplate === 'undefined'
                ? this.createDefaultMessage(context)
                : this.renderTemplate(telegram.messageTemplate, context);

        try {
            await axios.post(
                `https://api.telegram.org/bot${telegram.botToken}/sendMessage`,
                {
                    chat_id: telegram.chatId,
                    text,
                    parse_mode: telegram.parseMode,
                    disable_notification: telegram.disableNotification,
                    protect_content: telegram.protectContent,
                    message_thread_id: telegram.messageThreadId,
                },
                {
                    timeout: 10000,
                },
            );
        } catch (err: unknown) {
            if (this.isAxiosError(err) === true) {
                if (typeof err.response !== 'undefined') {
                    throw new Error(
                        `telegram notification failed: status=${err.response.status} ${err.response.statusText}`,
                    );
                }

                throw new Error(`telegram notification failed: ${err.message}`);
            }

            throw err;
        }

        this.log.system.info(`sent telegram notification: ${context.event}`);
        this.log.system.info(`sent telegram notification item: ${telegramName}`);
    }

    private async sendWebhook(webhook: NotificationWebhookConfig, context: NotificationContext): Promise<void> {
        const webhookName = webhook.name ?? 'unnamed';
        if (typeof webhook.delay !== 'undefined' && webhook.delay > 0) {
            this.log.system.info(`delay webhook notification: ${webhookName} ${webhook.delay}ms`);
            await this.sleep(webhook.delay);
        }

        const body = this.createWebhookBody(webhook, context);
        const contentType =
            webhook.contentType ?? (typeof webhook.bodyTemplate === 'undefined' ? 'application/json' : 'text/plain');
        const headers = this.renderHeaders(webhook.headers, context);
        headers['Content-Type'] = contentType;

        try {
            await axios.request({
                url: this.renderTemplate(webhook.url, context),
                method: webhook.method ?? 'POST',
                headers,
                data: body,
                timeout: webhook.timeout ?? 10000,
            });
            this.log.system.info(`sent webhook notification: ${webhookName}`);
        } catch (err: unknown) {
            if (this.isAxiosError(err) === true) {
                if (typeof err.response !== 'undefined') {
                    throw new Error(
                        `webhook failed: ${webhookName} status=${err.response.status} ${err.response.statusText}`,
                    );
                }

                throw new Error(`webhook failed: ${webhookName} ${err.message}`);
            }

            throw err;
        }
    }

    private createWebhookBody(webhook: NotificationWebhookConfig, context: NotificationContext): unknown {
        if (typeof webhook.bodyTemplate !== 'undefined') {
            return this.renderTemplate(webhook.bodyTemplate, context);
        }

        if (typeof webhook.json !== 'undefined') {
            return this.renderJson(webhook.json, context);
        }

        return context.payload;
    }

    private renderHeaders(
        headers: { [key: string]: string } | undefined,
        context: NotificationContext,
    ): {
        [key: string]: string;
    } {
        if (typeof headers === 'undefined') {
            return {};
        }

        const result: { [key: string]: string } = {};
        for (const key of Object.keys(headers)) {
            result[key] = this.renderTemplate(headers[key], context);
        }

        return result;
    }

    private renderJson(value: unknown, context: NotificationContext): unknown {
        if (typeof value === 'string') {
            return this.renderTemplateValue(value, context);
        }

        if (Array.isArray(value) === true) {
            return value.map(v => this.renderJson(v, context));
        }

        if (value !== null && typeof value === 'object') {
            const result: { [key: string]: unknown } = {};
            for (const key of Object.keys(value)) {
                result[key] = this.renderJson((value as { [key: string]: unknown })[key], context);
            }

            return result;
        }

        return value;
    }

    private renderTemplateValue(template: string, context: NotificationContext): TemplateValue | string {
        for (const key of Object.keys(context.values)) {
            const value = context.values[key];
            if (template === `%${key}%` || template === `{{${key}}}`) {
                return value;
            }
        }

        return this.renderTemplate(template, context);
    }

    private renderTemplate(template: string, context: NotificationContext): string {
        let result = template;

        for (const key of Object.keys(context.values)) {
            const value = context.values[key] === null ? '' : String(context.values[key]);
            result = result.split(`%${key}%`).join(value);
            result = result.split(`{{${key}}}`).join(value);
        }

        return result;
    }

    private createDefaultMessage(context: NotificationContext): string {
        const title = this.createDefaultTitle(context.event);
        const name = context.values.name;
        const channelName = context.values.channelName;
        const startAt = context.values.startAt;
        const endAt = context.values.endAt;
        const dropCnt = context.values.dropCnt;
        const errorCnt = context.values.errorCnt;
        const lines = [
            title,
            `番組: ${name}`,
            `放送局: ${channelName ?? ''}`,
            `時刻: ${typeof startAt === 'number' ? this.formatDate(startAt) : ''} - ${
                typeof endAt === 'number' ? this.formatDate(endAt) : ''
            }`,
        ];

        if (dropCnt !== null || errorCnt !== null) {
            lines.push(`Drop: ${dropCnt ?? 0} / Error: ${errorCnt ?? 0}`);
        }

        return lines.join('\n');
    }

    private formatDate(timestamp: number): string {
        return new Date(timestamp).toLocaleString();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    private createDefaultTitle(event: NotificationEvent): string {
        switch (event) {
            case 'recordingStart':
                return '録画を開始しました';
            case 'recordingFailed':
                return '録画に失敗しました';
            case 'recordingFinish':
                return '録画が完了しました';
        }
    }

    private isAxiosError(err: unknown): err is AxiosError {
        return axios.isAxiosError(err);
    }
}
