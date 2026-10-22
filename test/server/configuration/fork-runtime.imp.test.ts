import 'reflect-metadata';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const compiled = process.env.EPGSTATION_SERVER_COMPILED_SNAPSHOT;
if (!compiled) throw new Error('The compiled server snapshot is required');
const Configuration = require(join(compiled, 'model/Configuration.js')).default;
const { normalizeTunerService } = require(join(compiled, 'model/tuner/TunerServerAccessModel.js'));
const EPGUpdater = require(join(compiled, 'model/epgUpdater/EPGUpdater.js')).default;

const logger = () => {
    const system = { info: vi.fn(), warn: vi.fn(), fatal: vi.fn(), error: vi.fn() };
    return { getLogger: () => ({ system, stream: system }) };
};

describe('fork runtime preservation', () => {
    it('creates a missing main config from the template and continues with its values', () => {
        let created = false;
        const yaml = 'port: 48100\nepgUpdaterMode: fork\n';
        const access = {
            configPath: 'config.yml',
            templatePath: 'template.yml',
            readSync: (path: string) => {
                if (path === 'config.yml' && !created) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                return yaml;
            },
            copyTemplate: vi.fn(() => {
                created = true;
            }),
            watch: vi.fn(),
            unwatch: vi.fn(),
            read: async () => yaml,
        };
        const config = new Configuration(logger(), access).getConfig();
        expect(access.copyTemplate).toHaveBeenCalledExactlyOnceWith('config.yml');
        expect(config.port).toBe(48100);
        expect(config.epgUpdaterMode).toBe('fork');
        expect(access.watch).toHaveBeenCalledOnce();
    });

    it.each(['GR-ALT', 'NW1', 'NW40'])('normalizes array service channel %s without dropping its type', channelType => {
        const service = normalizeTunerService({
            id: 1,
            serviceId: 1,
            networkId: 1,
            name: 'synthetic',
            type: 1,
            channel: [{ type: channelType, channel: '1' }],
        });
        expect(service.channel).toEqual({ type: channelType, channel: '1' });
    });

    it('one-shot EPG updates finish persistence before notifying the parent', async () => {
        const calls: string[] = [];
        const manage = {
            on: vi.fn(),
            updateAll: async () => {
                calls.push('persist');
            },
            deleteOldPrograms: async () => {
                calls.push('cleanup');
            },
        };
        const updater = new EPGUpdater(logger(), { getConfig: () => ({ epgUpdateIntervalTime: 10 }) }, manage);
        updater.notify = async () => {
            calls.push('notify');
        };
        await updater.updateOnce();
        expect(calls).toEqual(['persist', 'cleanup', 'notify']);
    });
});
