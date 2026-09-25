// Shared by the browser importer and the existing CLI. No browser or Node globals.
const WEEK_BITS = [1, 2, 4, 8, 16, 32, 64];

export function nextQuarter(now = new Date()) {
    const year = now.getFullYear();
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    return quarter === 4 ? `${year + 1}-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}`;
}

export function quarterMonths(month) {
    if (!/^\d{4}-(01|04|07|10)$/.test(month)) throw new Error('四半期を選択してください');
    const [year, start] = month.split('-').map(Number);
    return [-1, 0, 1, 2].map(offset => {
        const date = new Date(Date.UTC(year, start - 1 + offset, 1));
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    });
}

export async function fetchBangumiWatching(user, request = fetch) {
    const subjects = [];
    for (let offset = 0; ; offset += 50) {
        const url = new URL(`https://api.bgm.tv/v0/users/${encodeURIComponent(user)}/collections`);
        Object.entries({ subject_type: '2', type: '3', limit: '50', offset: String(offset) })
            .forEach(([key, value]) => url.searchParams.set(key, value));
        const response = await request(url.toString(), { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Bangumi HTTP ${response.status}`);
        const json = await response.json();
        const page = Array.isArray(json?.data) ? json.data : [];
        for (const item of page) {
            if (item?.subject) subjects.push({
                id: item.subject.id,
                name: String(item.subject.name || '').trim(),
                nameCn: String(item.subject.name_cn || '').trim(),
                date: String(item.subject.date || '').trim(),
                coverUrl: String(item.subject.images?.small || item.subject.images?.grid || ''),
            });
        }
        if (page.length === 0 || offset + page.length >= json.total || page.length < 50) break;
    }
    return subjects;
}

export function filterQuarter(subjects, month) {
    const months = quarterMonths(month);
    return subjects.filter(subject => !subject.date || months.some(value => subject.date.startsWith(value)));
}

export function keywordVariants(title) {
    const chars = Array.from(title.trim());
    const min = Math.ceil(chars.length / 2);
    const variants = [];
    for (let length = chars.length; length >= min; length--) {
        const value = chars.slice(0, length).join('').trim();
        if (value && !variants.includes(value)) variants.push(value);
    }
    for (let start = 1; start + min <= chars.length; start++) {
        const value = chars.slice(start, start + min).join('').trim();
        if (value && !variants.includes(value)) variants.push(value);
    }
    return variants;
}

export async function searchTitle(title, search) {
    for (const keyword of keywordVariants(title)) {
        const programs = await search(keyword);
        if (programs.length) return { keyword, programs };
    }
    return { keyword: '', programs: [] };
}

export function candidateGroups(programs) {
    const groups = new Map();
    for (const program of [...programs].sort((a, b) => a.startAt - b.startAt)) {
        const parts = tokyoParts(program.startAt);
        const startSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
        const key = `${program.channelId}:${parts.weekday}:${startSeconds}`;
        const existing = groups.get(key);
        if (existing) existing.programs.push(program);
        else groups.set(key, { channelId: program.channelId, weekday: parts.weekday, startSeconds, program, programs: [program] });
    }
    return [...groups.values()];
}

function tokyoParts(timestamp) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo', hourCycle: 'h23', weekday: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
        hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

export function isBsChannel(channel) {
    const type = String(channel?.channelType || '').toUpperCase();
    const code = String(channel?.channel || '').toUpperCase();
    const name = String(channel?.name || '').toUpperCase();
    return type.startsWith('BS') || code.startsWith('BS') || /^ＢＳ/.test(name) || /[^Ａ-Ｚ]ＢＳ/.test(name) || /^BS/.test(name) || /[^A-Z]BS/.test(name);
}

export function defaultCandidateIndices(groups, channels) {
    const bs = groups.map((candidate, index) => isBsChannel(channels.get(candidate.channelId)) ? index : -1).filter(index => index >= 0);
    return bs.length ? bs : groups.length ? [0] : [];
}

export function directorySlug(subject) {
    const source = [subject.name, subject.nameCn].find(value => /^[\x20-\x7e]{5,}$/.test(value || ''));
    return source ? source.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 100) : `bgm-${subject.id}`;
}

export function createRule(subject, keyword, candidate, channel, month, rangeSeconds = 7200) {
    const number = String(channel?.remoteControlKeyId ?? channel?.channel ?? channel?.id ?? candidate.channelId)
        .replace(/[\\/:*?"<>|\s]+/g, '-').toLowerCase();
    return {
        isTimeSpecification: false,
        bangumiId: subject.id,
        searchOption: { keyword, keyCS: false, keyRegExp: false, name: true, description: false, extended: false,
            channelIds: [candidate.channelId], times: [{ start: Math.floor(candidate.startSeconds / 3600),
                range: Math.max(1, Math.ceil(rangeSeconds / 3600)), week: WEEK_BITS[candidate.weekday] }] },
        reserveOption: { enable: true, allowEndLack: true, removeDataBroadcast: true, avoidDuplicate: true },
        saveOption: { directory: `${month}/${number}-${subject.romaji || directorySlug(subject)}` },
    };
}

export function hasDuplicateRule(existingRules, rule) {
    const search = rule.searchOption;
    const time = search.times?.[0];
    return existingRules.some(existing => {
        const other = existing.searchOption || {};
        return existing.isTimeSpecification === rule.isTimeSpecification && other.keyword === search.keyword &&
            other.channelIds?.includes(search.channelIds?.[0]) && other.times?.some(value =>
                value.week === time?.week && value.start === time?.start && value.range === time?.range);
    });
}
