import * as apid from '../../../api';

export interface BangumiSubject { id: number; name: string; nameCn: string; date: string; coverUrl?: string; romaji?: string }
export interface RomajiResult { romaji: string; isRomajiFallback: boolean }
export interface Candidate { channelId: number; weekday: number; startSeconds: number; program: apid.ScheduleProgramItem; programs: apid.ScheduleProgramItem[] }
export function nextQuarter(now?: Date): string;
export function quarterMonths(month: string): string[];
export function quarterLabel(month: string): string;
export function fetchBangumiWatching(user: string, request?: typeof fetch): Promise<BangumiSubject[]>;
export function resolveRomaji(subject: BangumiSubject, request?: typeof fetch): Promise<RomajiResult>;
export function filterQuarter(subjects: BangumiSubject[], month: string): BangumiSubject[];
export function keywordVariants(title: string): string[];
export function scanWithConcurrency<T, R>(subjects: T[], limit: number, scan: (subject: T) => Promise<R>, publish: (result: R) => void): Promise<void>;
export function searchTitle(title: string, search: (keyword: string) => Promise<apid.ScheduleProgramItem[]>): Promise<{ keyword: string; programs: apid.ScheduleProgramItem[] }>;
export function candidateGroups(programs: apid.ScheduleProgramItem[]): Candidate[];
export function isBsChannel(channel?: apid.ChannelItem): boolean;
export function defaultCandidateIndices(groups: Candidate[], channels: Map<number, apid.ChannelItem>): number[];
export function directorySlug(subject: BangumiSubject): string;
export function isValidDirectory(value: string | undefined): boolean;
export function createRule(subject: BangumiSubject, keyword: string, candidate: Candidate, channel: apid.ChannelItem | undefined, month: string, rangeSeconds?: number): apid.AddRuleOption & { saveOption: apid.ReserveSaveOption };
export function hasDuplicateRule(existingRules: apid.Rule[], rule: apid.AddRuleOption): boolean;
