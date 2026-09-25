// Shared romaji selection used by the CLI and browser preview.
export function extractBangumiAliases(detail) {
    const values = [];

    if (detail?.name) {
        values.push(String(detail.name));
    }
    if (detail?.name_cn) {
        values.push(String(detail.name_cn));
    }

    for (const item of Array.isArray(detail?.infobox) ? detail.infobox : []) {
        if (isAliasInfoboxKey(item?.key)) {
            collectInfoboxStrings(item?.value, values);
        }
    }

    return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function isAliasInfoboxKey(key) {
    return /^(别名|別名|英文名|英語タイトル|罗马字|羅馬字|ローマ字|原文名)$/.test(String(key || '').trim());
}

function collectInfoboxStrings(value, values) {
    if (typeof value === 'string') {
        values.push(value);
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectInfoboxStrings(item?.v ?? item, values);
        }
    }
}

export function createRomajiSlug(subject, aliases, options) {
    const mapped = options.romajiMap[String(subject.id)] || options.romajiMap[subject.name] || options.romajiMap[subject.nameCn];
    if (mapped) {
        return { romaji: sanitizeRomajiSlug(mapped), isRomajiFallback: false };
    }

    const candidates = [...aliases, subject.name, subject.nameCn]
        .filter(isLikelyRomajiAlias)
        .map(value => asciiSlug(value))
        .filter(value => value.length > 0 && /[a-z]/.test(value));

    if (candidates.length > 0) {
        return { romaji: candidates.sort((a, b) => scoreSlug(b) - scoreSlug(a))[0], isRomajiFallback: false };
    }

    return { romaji: `bgm-${subject.id}`, isRomajiFallback: true };
}

export function pickMyAnimeListMatch(subject, items) {
    if (items.length === 0) {
        return null;
    }

    const normalizedSubject = normalizeTitle(subject.name);
    const scored = items.map(item => {
        const titles = collectMyAnimeListTitles(item);
        const score = Math.max(...titles.map(title => scoreTitleMatch(normalizedSubject, normalizeTitle(title))));
        return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].score <= 0 ? null : scored[0].item;
}

function collectMyAnimeListTitles(item) {
    const titles = [];
    for (const field of ['title', 'title_japanese', 'title_english']) {
        if (item?.[field]) {
            titles.push(String(item[field]));
        }
    }
    for (const title of Array.isArray(item?.titles) ? item.titles : []) {
        if (title?.title) {
            titles.push(String(title.title));
        }
    }
    return [...new Set(titles)];
}

function scoreTitleMatch(expected, actual) {
    if (expected.length === 0 || actual.length === 0) {
        return 0;
    }
    if (expected === actual) {
        return 100;
    }
    if (expected.includes(actual) || actual.includes(expected)) {
        return 80;
    }

    const minLength = Math.min(expected.length, actual.length);
    let prefix = 0;
    while (prefix < minLength && expected[prefix] === actual[prefix]) {
        prefix++;
    }
    return prefix >= Math.ceil(expected.length / 2) ? 40 + prefix : 0;
}

function normalizeTitle(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[「」『』【】\[\]（）()～〜:：・,，.。!！?？\s]/g, '')
        .toLowerCase();
}

export function extractMyAnimeListRomaji(item) {
    const titles = [];
    if (item?.title) {
        titles.push(item.title);
    }
    for (const title of Array.isArray(item?.titles) ? item.titles : []) {
        if (title?.type === 'Default' && title?.title) {
            titles.unshift(title.title);
        } else if (title?.title) {
            titles.push(title.title);
        }
    }
    if (item?.title_english) {
        titles.push(item.title_english);
    }

    const candidates = titles
        .filter(isLikelyRomajiAlias)
        .map(value => asciiSlug(value))
        .filter(value => value.length > 0 && /[a-z]/.test(value));
    return candidates.length === 0 ? null : candidates.sort((a, b) => scoreSlug(b) - scoreSlug(a))[0];
}

export function sanitizeRomajiSlug(value) {
    return asciiSlug(value) || String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'unknown';
}

function isUrlLikeAlias(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return (
        normalized.includes('://') ||
        normalized.startsWith('www.') ||
        normalized.startsWith('@') ||
        /\b(x|twitter|instagram|youtube|tiktok)\.com\b/.test(normalized) ||
        /\b[a-z0-9-]+\.(com|jp|net|org|tv|info|biz|co|io)\b/.test(normalized)
    );
}

function isLikelyRomajiAlias(value) {
    if (isUrlLikeAlias(value)) {
        return false;
    }

    const text = String(value || '').trim();
    if (text.length === 0) {
        return false;
    }

    const asciiChars = Array.from(text).filter(char => /[A-Za-z0-9 .,:'"!?&()[\]_-]/.test(char)).length;
    const letterChars = Array.from(text).filter(char => /[A-Za-z]/.test(char)).length;
    return asciiChars / Array.from(text).length >= 0.6 && letterChars >= 5;
}

function scoreSlug(value) {
    const wordCount = value.split('-').filter(Boolean).length;
    const lengthScore = Math.min(value.length, 80);
    return wordCount * 10 + lengthScore;
}

function asciiSlug(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .toLowerCase()
        .slice(0, 100);
}
