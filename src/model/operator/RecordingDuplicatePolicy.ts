import StrUtil from '../../util/StrUtil.js';

interface EpisodeMetadata {
    name: string;
    description?: string | null;
}

export interface DuplicateHistory extends EpisodeMetadata {
    channelId: number;
    endAt: number;
}

interface DuplicateProgram extends DuplicateHistory {
    startAt: number;
}

const normalize = (value: string): string =>
    StrUtil.toHalf(StrUtil.replaceEnclosedCharacters(value)).replace(/\s+/g, ' ').trim();

// Only broadcast flags are removed; brackets can also be part of a work's title.
const broadcastFlags = /\[(?:再|再放送|新|初|終|字|字幕|双|二|デ|解|多|手|HV|SD|HD|4K|HDR|S|SS|無|料)\]/gi;
const repeatFlag = /\[(?:再|再放送)\]/;
const episodePattern = /第\s*(\d+)\s*[話回]|#\s*(\d+)(?!\d|\.\d)|\b(?:chapter|episode|ep)\.?\s*(\d+)(?!\d|\.\d)/gi;

const hasEpisodeRange = (suffix: string): boolean =>
    /^\s*(?:[~〜～\-－–—・、,/&]\s*(?:第\s*|#\s*)?\d|第\s*\d+\s*[話回])/.test(suffix);

interface EpisodeIdentity {
    title: string;
    episode: number;
}

const identity = (metadata: EpisodeMetadata): EpisodeIdentity | null => {
    const title = normalize(metadata.name).replace(broadcastFlags, '').trim();
    const titleEpisodes = [...title.matchAll(episodePattern)];
    // Multiple episodes / omnibus broadcasts are not interchangeable with one episode.
    if (titleEpisodes.length > 1) {
        return null;
    }
    if (titleEpisodes.some(match => hasEpisodeRange(title.slice((match.index ?? 0) + match[0].length)))) {
        return null;
    }
    const description = normalize(metadata.description ?? '');
    // Do not mistake episode numbers mentioned in a synopsis or staff list for this episode.
    const descriptionEpisode = description.match(
        /^(?:第\s*(\d+)\s*[話回]|#\s*(\d+)(?!\d|\.\d)|(?:chapter|episode|ep)\.?\s*(\d+)(?!\d|\.\d))(?=$|[^\d])/i,
    );
    if (descriptionEpisode !== null && hasEpisodeRange(description.slice(descriptionEpisode[0].length))) {
        return null;
    }
    const numberOf = (match: RegExpMatchArray): number => Number(match[1] ?? match[2] ?? match[3]);
    const titleEpisode = titleEpisodes.length === 1 ? numberOf(titleEpisodes[0]) : null;
    const summaryEpisode = descriptionEpisode === null ? null : numberOf(descriptionEpisode);
    if (titleEpisode !== null && summaryEpisode !== null && titleEpisode !== summaryEpisode) {
        return null;
    }
    const episode = titleEpisode ?? summaryEpisode;
    if (episode === null || !Number.isSafeInteger(episode) || episode < 1) {
        return null;
    }
    const series = title
        .replace(episodePattern, '')
        .replace(/\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return series.length === 0 ? null : { title: series, episode };
};

/** Conservative: an uncertain match must not prevent recording a new episode. */
export default class RecordingDuplicatePolicy {
    public static isRepeat(name: string): boolean {
        return repeatFlag.test(normalize(name));
    }

    public static canCheck(program: EpisodeMetadata): boolean {
        return this.isRepeat(program.name) && identity(program) !== null;
    }

    public static isDuplicate(
        program: DuplicateProgram,
        history: DuplicateHistory,
        periodDays?: number,
        now: number = Date.now(),
    ): boolean {
        if (
            !this.isRepeat(program.name) ||
            program.channelId !== history.channelId ||
            history.endAt > now ||
            history.endAt > program.startAt
        ) {
            return false;
        }
        if (typeof periodDays !== 'undefined' && periodDays > 0) {
            const period = periodDays * 24 * 60 * 60 * 1000;
            if (history.endAt < now - period || program.endAt > history.endAt + period) {
                return false;
            }
        }
        const current = identity(program);
        const previous = identity(history);
        return (
            current !== null &&
            previous !== null &&
            current.title === previous.title &&
            current.episode === previous.episode
        );
    }
}
