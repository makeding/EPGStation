const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
// Compile in memory so regression tests exercise source without creating another build tree.
require.extensions['.ts'] = (module, filename) => {
    const source = process.env.TEST_BASELINE === '1' && filename.includes('/src/model/')
        ? require('node:child_process').execFileSync('git', ['show', `HEAD:${filename.slice(process.cwd().length + 1)}`], { encoding: 'utf8' })
        : fs.readFileSync(filename, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
        experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    }}).outputText, filename);
};
const Execution = require('../src/model/ExecutionManagementModel.ts').default;
const Reservation = require('../src/model/operator/reservation/ReservationManageModel.ts').default;
const logger = { getLogger: () => ({ system: { info() {}, warn() {}, error() {} } }) };

test('timed-out waiter cannot inherit and strand the lock', async () => {
    const lock = new Execution(logger);
    const owner = await lock.getExecution(1);
    await assert.rejects(lock.getExecution(1, 5), /GetExecutionTimeoutError/);
    const next = lock.getExecution(1, 100);
    lock.unLockExecution(owner);
    const nextId = await next;
    lock.unLockExecution(nextId);
    assert.equal(lock.exeQueue.length, 0);
    assert.equal(lock.exeEventEmitter.listenerCount('ExeUnlock'), 0);
});

test('surviving waiters retain priority and FIFO order', async () => {
    const lock = new Execution(logger);
    const owner = await lock.getExecution(1);
    const first = lock.getExecution(1, 100);
    const second = lock.getExecution(1, 100);
    const high = lock.getExecution(2, 100);
    lock.unLockExecution(owner);
    const highId = await high;
    lock.unLockExecution(highId);
    const firstId = await first;
    lock.unLockExecution(firstId);
    lock.unLockExecution(await second);
    assert.equal(lock.lockId, null);
});

for (const scenario of ['rule DB failure', 'invalid time rule', 'unexpected add exception', 'cancel DB failure', 'cleanup DB failure']) {
    test(`${scenario} releases reservation lock for the next operation`, async () => {
        const lock = new Execution(logger);
        const failure = new Error('InjectedFailure');
        const db = { findId: async () => { throw failure; }, findOldTime: async () => { throw failure; }, findRuleId: async () => [] };
        const rules = { findId: async () => { throw failure; } };
        const model = new Reservation(logger, { getConfig: () => ({}) }, lock, {}, db, {}, {}, rules, { emitUpdated() {} });
        let run;
        if (scenario === 'rule DB failure') run = () => model.updateRule(1);
        if (scenario === 'invalid time rule') {
            rules.findId = async () => ({ reserveOption: { enable: true }, isTimeSpecification: true,
                searchOption: { keyword: 'test', channelIds: [], times: [{ week: 1 }] } });
            run = () => model.updateRule(1);
        }
        if (scenario === 'unexpected add exception') {
            model.checkManualReserveOption = () => true;
            model.createManualReserveWithProgramId = async () => ({});
            model.checkSingleReserveConflict = () => { throw failure; };
            run = () => model.add({ programId: 1 });
        }
        if (scenario === 'cancel DB failure') run = () => model.cancel(1);
        if (scenario === 'cleanup DB failure') run = () => model.cleanup();
        await assert.rejects(run(), /InjectedFailure|RuleSearchTimesOptionError/);
        const nextId = await lock.getExecution(1, 30);
        lock.unLockExecution(nextId);
    });
}

const EventSetter = require('../src/model/event/EventSetter.ts').default;
for (const ruleId of [null, 257]) {
    test(`finish-recording failure is logged with identifiers (rule ${ruleId})`, async () => {
        const setter = Object.create(EventSetter.prototype);
        let finish;
        const errors = [];
        const failure = new Error('GetExecutionTimeoutError');
        const events = new Proxy({}, { get: (_, key) => callback => {
            if (key === 'setFinishRecording') finish = callback;
        }});
        for (const key of ['epgUpdateEvent', 'ruleEvent', 'reserveEvent', 'recordingEvent', 'recordedEvent', 'recordedTagEvent', 'thumbnailEvent', 'encodeEvent']) setter[key] = events;
        setter.log = { system: { error: value => errors.push(value) } };
        setter.reservationManage = { cancel: async () => { throw failure; }, updateRule: async () => { throw failure; } };
        setter.externalCommandManage = { addRecordingFinishCmd() {} };
        setter.notificationManage = { addRecordingFinish() {} };
        setter.ipc = { notifyClient() {} };
        setter.set();
        await finish({ id: 3305, ruleId, isEventRelay: false, tags: null }, { id: 2461, videoFiles: [] }, true);
        assert.match(errors[0], /reserveId: 3305/);
        assert.match(errors[0], /recordedId: 2461/);
        if (ruleId !== null) assert.match(errors[0], /ruleId: 257/);
        assert.equal(errors[1], failure);
    });
}
