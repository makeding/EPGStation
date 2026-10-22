// Run against an isolated MariaDB restored directly from the supplied fork snapshot.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import container from '../dist/model/ModelContainer.js';
import { set } from '../dist/model/ModelContainerSetter.js';
import Configuration from '../dist/model/Configuration.js';

const socketPath = process.env.SNAPSHOT_DB_SOCKET;
const workDir = process.env.SNAPSHOT_WORK_DIR;
assert(socketPath && workDir, 'SNAPSHOT_DB_SOCKET and SNAPSHOT_WORK_DIR are required');
const sql = await mysql.createConnection({ socketPath, user: 'root', database: 'epgstation' });
const [tables] = await sql.query('SHOW TABLES');
const before = [];
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
for (const item of tables) {
    const table = Object.values(item)[0];
    const [columns] = await sql.query(`SHOW COLUMNS FROM \`${table}\``);
    const select = columns.map(c => `\`${c.Field}\``).join(',');
    const [rows] = await sql.query(`SELECT ${select} FROM \`${table}\` ORDER BY 1`);
    before.push({ table, select, count: rows.length, hash: digest(rows) });
}
console.log(
    'Prior tables:',
    before.map(({ table, count }) => ({ table, count })),
);
const [priorRules] = await sql.query('SELECT * FROM rule ORDER BY id');
const [priorChannels] = await sql.query('SELECT * FROM channel ORDER BY id');
const [priorReserves] = await sql.query('SELECT * FROM reserve ORDER BY id');
const [priorHistory] = await sql.query('SELECT * FROM migrations ORDER BY id');
console.log('Prior migration history:', priorHistory);
set(container);
container.get('ILoggerModel').initialize();
const configuration = {
    ...structuredClone(Configuration.DEFAULT_VALUE),
    dbtype: 'mysql',
    mysql: { socketPath, user: 'root', database: 'epgstation' },
    port: 0,
    apiServers: ['http://127.0.0.1'],
    uploadTempDir: `${workDir}/uploads`,
};
container.rebind('IConfiguration').toConstantValue({ getConfig: () => structuredClone(configuration) });
const service = container.get('IServiceServer');
const server = service.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let connection;
try {
    // First consumer request triggers the production DBOperator migration path.
    const get = async path => {
        const response = await fetch(origin + '/api' + path, { signal: AbortSignal.timeout(15000) });
        const body = await response.text();
        assert.equal(response.status, 200, `${path}: ${body}`);
        console.log('HTTP', path, response.status, Buffer.byteLength(body), 'bytes');
        return JSON.parse(body);
    };
    const rules = await get('/rules?offset=0&limit=1000');
    assert.equal(rules.total, priorRules.length);
    assert.equal(rules.rules.length, priorRules.length);
    for (const old of priorRules) {
        const rule = rules.rules.find(r => r.id === old.id);
        assert(rule);
        assert.equal(rule.bangumiId ?? null, old.bangumi_id);
        assert.equal(rule.reserveOption.removeDataBroadcast, Boolean(old.removeDataBroadcast));
        for (const wave of ['GR-ALT', ...Array.from({ length: 40 }, (_, i) => `NW${i + 1}`)]) {
            assert.equal(rule.searchOption[wave], Boolean(old[wave]), `rule ${old.id} ${wave}`);
        }
        const detail = await get(`/rules/${old.id}`);
        assert.deepEqual(detail, rule);
    }
    const channels = await get('/channels');
    for (const channel of channels) {
        const old = priorChannels.find(c => c.id === channel.id);
        assert(old);
        assert.equal(channel.channelType, old.channelType);
    }
    if (channels.length) {
        const selected = await get(`/channels?channelId=${channels[0].id}`);
        assert.deepEqual(selected, [channels[0]]);
    }
    const reserves = await get('/reserves?offset=0&limit=1000&isHalfWidth=false');
    for (const item of reserves.reserves) {
        const old = priorReserves.find(r => r.id === item.id);
        assert(old);
        assert.equal(item.removeDataBroadcast, Boolean(old.removeDataBroadcast));
        assert.equal(item.channelId, old.channelId);
        assert.equal(item.startAt, old.startAt);
        assert.equal(item.endAt, old.endAt);
        assert.equal(item.channelType, old.channelType);
    }
    const recorded = await get('/recorded?offset=0&limit=50&isHalfWidth=false');
    if (recorded.records?.length) await get(`/recorded/${recorded.records[0].id}?isHalfWidth=false`);
    const [[range]] = await sql.query('SELECT MIN(startAt) AS startAt FROM program');
    const params = new URLSearchParams({
        startAt: String(range.startAt),
        endAt: String(Number(range.startAt) + 86400000),
        isHalfWidth: 'false',
        GR: 'true',
        BS: 'true',
        CS: 'true',
        SKY: 'true',
        BS4K: 'true',
        'GR-ALT': 'true',
        NW1: 'true',
        NW40: 'true',
    });
    await get(`/schedules?${params}`);
    connection = await container.get('IDBOperator').getConnection();
    for (const entry of before.filter(t => t.table !== 'migrations')) {
        const [rows] = await sql.query(`SELECT ${entry.select} FROM \`${entry.table}\` ORDER BY 1`);
        assert.equal(rows.length, entry.count, `${entry.table} row count`);
        assert.equal(digest(rows), entry.hash, `${entry.table} original column values`);
    }
    const [history] = await sql.query('SELECT * FROM migrations ORDER BY id');
    assert.deepEqual(history.slice(0, priorHistory.length), priorHistory);
    assert.equal(history.length, priorHistory.length + 2);
    console.log(
        'PASS: original table data unchanged, migration history preserved, BS4K + encode queue applied, HTTP readback verified.',
    );
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    connection ??= container.get('IDBOperator').connection;
    if (connection?.isInitialized) await connection.destroy();
    await sql.end();
}
