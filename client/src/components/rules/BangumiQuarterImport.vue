<template>
    <v-card outlined class="mb-5">
        <v-card-title>Bangumi 四半期作品からルールを作成</v-card-title>
        <v-card-text>
            <p class="mb-2">
                「見てる」に追加したアニメを、対象四半期の番組表と自動的に照合します。放送予定が見つかった作品は一覧に並ぶので、
                中身を確認・調整してそのまま録画ルールとしてまとめて登録できます。
            </p>
            <ul class="help-note mb-3">
                <li>候補は MBS/TBS などの地上波を優先して選択し、地上波がなければ BS 放送を初期選択します。保存先は候補ごとに編集してリセットできます。</li>
                <li>照合しただけでは何も作成されません。「作成」ボタンで選択したルールだけを確定します。登録済みの作品は上書きしません。</li>
                <li>Bangumi アカウント名はサーバーに保存されません。照合はこのブラウザから直接 Bangumi API へ行い、アカウント名はブラウザの中だけで使います。</li>
                <li>次の四半期の番組は季節の始まり約 8 日前から番組表に載り始めます。既定ではその時期から対象四半期を新シーズンへ切り替えます。</li>
            </ul>
            <v-row align="center">
                <v-col cols="12" sm="5"><v-text-field v-model.trim="user" label="Bangumi アカウント" :disabled="busy" hide-details="auto"></v-text-field></v-col>
                <v-col cols="12" sm="4">
                    <v-select
                        v-model="quarter"
                        :items="quarters"
                        label="対象四半期"
                        :disabled="busy"
                        hide-details="auto"
                        hint="変えると照合結果をいったん消します"
                        persistent-hint
                    ></v-select>
                </v-col>
                <v-col cols="12" sm="3"><v-btn color="primary" block :loading="scanning" :disabled="busy || !user" v-on:click="scan">番組表を照合</v-btn></v-col>
            </v-row>
            <div class="status-slot" role="status" aria-live="polite">{{ status }}</div>
            <v-alert v-if="restored" type="info" outlined dense class="mb-3">前回の照合結果（{{ restoredInfo }}）を復元しました。必要なら「番組表を照合」で取り直せます。</v-alert>
            <v-alert v-if="error" type="error" outlined dense>
                {{ error }}
                <span>アカウント名と通信状態を確認し、再度照合してください。</span>
            </v-alert>
            <template v-if="items.length">
                <v-divider class="mb-3"></v-divider>
                <div v-for="item in items" :key="item.subject.id" :ref="`subject-${item.subject.id}`" class="subject-row py-2" tabindex="-1">
                    <v-expansion-panels v-model="item.openPanel" accordion flat class="subject-collapse">
                        <v-expansion-panel>
                            <v-expansion-panel-header :disabled="saving">
                                <div class="d-flex align-center">
                                    <div class="cover mr-3">
                                        <img
                                            v-if="item.subject.coverUrl"
                                            :src="item.subject.coverUrl"
                                            :alt="`${item.subject.name} の表紙`"
                                            v-on:error="item.subject.coverUrl = ''"
                                        />
                                        <span v-else>表紙なし</span>
                                    </div>
                                    <div class="subject-details">
                                        <div class="font-weight-medium">
                                            {{ item.subject.name }}
                                            <span v-if="item.subject.nameCn">
                                                /
                                                <span lang="zh-CN" class="name-cn">{{ item.subject.nameCn }}</span>
                                            </span>
                                        </div>
                                        <div class="caption">
                                            放送開始: {{ item.subject.date || '日付不明' }}
                                            <v-chip v-if="item.alreadyLinked" x-small color="primary" outlined class="ml-1">ルール登録済み</v-chip>
                                            <v-chip v-if="item.alreadyLinked" x-small outlined :color="item.linkedReserves === 0 ? 'warning' : undefined" class="ml-1">
                                                予約件数 {{ item.linkedReserves === null ? '?' : item.linkedReserves }}
                                            </v-chip>
                                            <v-chip v-if="!item.alreadyLinked && item.choices.length" x-small outlined class="ml-1">候補 {{ item.choices.length }} 件</v-chip>
                                            <v-chip v-if="!item.alreadyLinked && !item.choices.length && item.reason" x-small outlined color="warning" class="ml-1">要確認</v-chip>
                                            <span v-if="item.reason">— {{ item.reason }}</span>
                                        </div>
                                        <div v-if="item.alreadyLinked && item.linkedReserves === 0" class="caption warning--text">
                                            登録済みのルールに現在一致する放送予定がありません。展開して候補を確認・再作成できます。
                                        </div>
                                    </div>
                                </div>
                            </v-expansion-panel-header>
                            <v-expansion-panel-content>
                                <v-btn v-if="item.lookupFailed" small text color="primary" :loading="item.searching" :disabled="busy" v-on:click="retry(item)">
                                    この作品を再検索
                                </v-btn>
                                <div v-for="(choice, index) in item.choices" :key="index" class="choice-row">
                                    <v-checkbox
                                        v-model="choice.selected"
                                        :disabled="busy || choice.result === 'created' || choice.result === 'exists'"
                                        class="candidate-checkbox my-0"
                                        dense
                                        hide-details
                                    >
                                        <template v-slot:label>
                                            <span>
                                                {{ choice.candidate.program.name }} · {{ choice.channelLabel }} · {{ formatDate(choice.candidate.program.startAt) }} ·
                                                {{ formatTime(choice.candidate.startSeconds) }}–{{ formatTime(choice.candidate.startSeconds + 7200) }}
                                            </span>
                                        </template>
                                    </v-checkbox>
                                    <div class="caption choice-detail">検索: {{ item.keyword }}</div>
                                    <div class="path-row choice-detail">
                                        <v-text-field
                                            v-model.trim="choice.rule.saveOption.directory"
                                            class="path-field"
                                            label="保存先"
                                            dense
                                            outlined
                                            :rules="[directoryRule]"
                                            :disabled="busy || choice.result === 'created' || choice.result === 'exists'"
                                        ></v-text-field>
                                        <v-btn class="path-reset" small text :disabled="cannotResetDirectory(choice)" v-on:click="resetDirectory(choice)">リセット</v-btn>
                                    </div>
                                    <div class="caption choice-detail">
                                        <span v-if="choice.result" :class="choice.result === 'failed' ? 'error--text' : choice.result === 'creating' ? '' : 'success--text'">
                                            · {{ resultLabel(choice) }}
                                        </span>
                                    </div>
                                </div>
                            </v-expansion-panel-content>
                        </v-expansion-panel>
                    </v-expansion-panels>
                </div>
                <v-divider class="mt-4 mb-4"></v-divider>
                <div class="confirm-actions">
                    <v-btn class="confirm-btn" color="primary" :loading="saving" :disabled="busy || selectedCount === 0 || invalidSelection" v-on:click="confirm">
                        選択した {{ saving ? confirmCount : selectedCount }} 件のルールを作成
                    </v-btn>
                    <span class="caption">MBS/TBS の地上波を優先し、なければ BS 候補を初期選択します。チェックを変更できます。</span>
                </div>
                <div class="validation-slot error--text" role="status">{{ invalidSelection ? '選択した候補の保存先を確認してください。' : '' }}</div>
            </template>
        </v-card-text>
    </v-card>
</template>

<script lang="ts">
import { Component, Vue, Watch } from 'vue-property-decorator';
import * as apid from '../../../../api';
import container from '@/model/ModelContainer';
import IRuleApiModel from '@/model/api/rule/IRuleApiModel';
import IScheduleApiModel from '@/model/api/schedule/IScheduleApiModel';
import IChannelsApiModel from '@/model/api/channels/IChannelsApiModel';
import IStorageOperationModel from '@/model/storage/IStorageOperationModel';
import {
    BangumiSubject,
    Candidate,
    candidateGroups,
    createRule,
    defaultCandidateIndices,
    defaultQuarter,
    fetchBangumiWatching,
    filterQuarter,
    hasDuplicateRule,
    isValidDirectory,
    quarterLabel,
    resolveRomaji,
    scanWithConcurrency,
    searchTitle,
} from '@/lib/bangumiImport.mjs';

interface Choice {
    candidate: Candidate;
    rule: apid.AddRuleOption & { saveOption: apid.ReserveSaveOption };
    channelLabel: string;
    selected: boolean;
    result: '' | 'creating' | 'created' | 'exists' | 'failed';
    detail: string;
    defaultDirectory: string;
}
interface Item {
    subject: BangumiSubject;
    keyword: string;
    reason: string;
    choices: Choice[];
    lookupFailed: boolean;
    searching: boolean;
    alreadyLinked: boolean;
    linkedReserves: number | null;
    openPanel: number | null;
}

// The scan is slow and expensive, so keep its result while the user walks to
// another page and back. Restored results re-check the linked rule state.
interface ScanCache {
    user: string;
    quarter: string;
    savedAt: number;
    items: Item[];
}
let scanCache: ScanCache | null = null;

@Component
export default class BangumiQuarterImport extends Vue {
    public user = '';
    public quarter = defaultQuarter();
    public restored = false;
    public restoredInfo = '';
    public scanning = false;
    public saving = false;
    public status = '';
    public error = '';
    public items: Item[] = [];
    public retrying = 0;
    public confirmCount = 0;
    private restoring = false;
    private channels = new Map<number, apid.ChannelItem>();
    private existingBangumiIds = new Set<number>();
    private linkedRules = new Map<number, apid.Rule>();

    private ruleApi = container.get<IRuleApiModel>('IRuleApiModel');
    private scheduleApi = container.get<IScheduleApiModel>('IScheduleApiModel');
    private channelsApi = container.get<IChannelsApiModel>('IChannelsApiModel');
    private storage = container.get<IStorageOperationModel>('IStorageOperationModel');

    get busy(): boolean {
        return this.scanning || this.saving || this.retrying > 0;
    }
    get selectedCount(): number {
        return this.items.reduce((count, item) => count + item.choices.filter(choice => choice.selected && (!choice.result || choice.result === 'failed')).length, 0);
    }
    get invalidSelection(): boolean {
        return this.items.some(item =>
            item.choices.some(choice => choice.selected && (!choice.result || choice.result === 'failed') && !isValidDirectory(choice.rule.saveOption.directory)),
        );
    }
    get quarters(): Array<{ text: string; value: string }> {
        const today = new Date();
        const year = today.getFullYear();
        const starts = [year - 1, year, year + 1, year + 2].flatMap(y => [1, 4, 7, 10].map(m => `${y}-${String(m).padStart(2, '0')}`));
        return starts.map(value => ({ value, text: quarterLabel(value) }));
    }

    public created(): void {
        this.user = this.storage.get('bangumi-quarter-user') || '';
        this.restore();
        if (this.restored) {
            void this.refreshLinkedRules().catch(() => {
                // Cached linked counts stay visible even while offline.
            });
        }
    }

    @Watch('items', { deep: true })
    public onItemsChanged(): void {
        if (!this.restoring) this.persist();
    }

    @Watch('quarter')
    public onQuarterChanged(): void {
        this.items = [];
        this.restored = false;
        this.restoredInfo = '';
        this.error = '';
        this.status = '';
    }

    @Watch('user')
    public onUserChanged(): void {
        if (this.restored) {
            const cached = scanCache;
            if (cached !== null && cached.user !== this.user) {
                this.restored = false;
            }
        }
    }

    public async scan(): Promise<void> {
        if (this.busy || !this.user) return;
        this.scanning = true;
        this.restored = false;
        this.restoredInfo = '';
        this.error = '';
        this.items = [];
        this.status = '既存ルールを確認しています…';
        try {
            await this.refreshLinkedRules();
            this.status = 'Bangumi の作品を取得しています…';
            const subjects = filterQuarter(await fetchBangumiWatching(this.user), this.quarter);
            this.storage.set('bangumi-quarter-user', this.user);
            if (!subjects.length) {
                this.status = '対象期間の「見てる」作品はありません。';
                return;
            }
            this.channels = new Map((await this.channelsApi.getChannels()).map(channel => [channel.id, channel]));
            this.status = `0 / ${subjects.length} 作品を照合しました。`;
            await scanWithConcurrency(
                subjects,
                3,
                subject => this.scanSubject(subject),
                item => {
                    this.items.push(item);
                    this.status = `${this.items.length} / ${subjects.length} 作品を照合しました。`;
                },
            );
            this.status = `${this.items.length} 作品を確認しました。候補を選んでルールを作成できます。`;
        } catch (err: any) {
            this.error = `照合に失敗しました: ${this.message(err)}`;
            this.status = '照合を完了できませんでした。';
        } finally {
            this.scanning = false;
        }
    }

    public async retry(item: Item): Promise<void> {
        if (this.busy || !item.lookupFailed) return;
        this.retrying++;
        item.searching = true;
        item.reason = '番組表を再検索しています…';
        try {
            const refreshed = await this.scanSubject(item.subject);
            const openPanel = item.openPanel;
            Object.assign(item, refreshed);
            item.openPanel = openPanel;
            if (!item.lookupFailed) {
                this.$nextTick(() => {
                    const rows = this.$refs[`subject-${item.subject.id}`] as HTMLElement[] | undefined;
                    rows?.[0]?.focus();
                });
            }
        } finally {
            item.searching = false;
            this.retrying--;
        }
    }

    private async scanSubject(subject: BangumiSubject): Promise<Item> {
        const alreadyLinked = this.existingBangumiIds.has(subject.id);
        const item: Item = {
            subject,
            keyword: '',
            reason: '',
            choices: [],
            lookupFailed: false,
            searching: false,
            alreadyLinked,
            linkedReserves: this.linkedRules.get(subject.id)?.reservesCnt ?? null,
            openPanel: null,
        };
        if (!subject.date) {
            item.reason = '放送開始日が不明のため自動選択しません';
            return item;
        }
        if (!subject.name) {
            item.reason = '作品名がありません';
            return item;
        }
        try {
            const found = await searchTitle(subject.name, keyword =>
                this.scheduleApi.getScheduleSearch({
                    option: { keyword, keyCS: false, keyRegExp: false, name: true, description: false, extended: false },
                    isHalfWidth: false,
                    limit: 50,
                }),
            );
            item.keyword = found.keyword;
            const groups = candidateGroups(found.programs);
            if (!groups.length) {
                item.reason = '番組表に一致する番組がありません';
                return item;
            }
            const romaji = await resolveRomaji(subject);
            const subjectWithRomaji = { ...subject, romaji: romaji.romaji };
            const defaults = defaultCandidateIndices(groups, this.channels, alreadyLinked);
            item.choices = groups.map((candidate, index) => {
                const channel = this.channels.get(candidate.channelId);
                const rule = createRule(subjectWithRomaji, found.keyword, candidate, channel, this.quarter);
                return {
                    candidate,
                    channelLabel: channel ? `${channel.remoteControlKeyId ?? channel.channel} ${channel.name}` : `ch:${candidate.channelId}`,
                    rule,
                    selected: defaults.includes(index),
                    result: '',
                    detail: '',
                    defaultDirectory: rule.saveOption.directory || '',
                };
            });
        } catch (err: any) {
            item.reason = `番組表の検索に失敗: ${this.message(err)}`;
            item.lookupFailed = true;
            item.openPanel = 0;
        }
        return item;
    }

    public async confirm(): Promise<void> {
        if (this.busy || !this.selectedCount || this.invalidSelection) return;
        this.confirmCount = this.selectedCount;
        this.saving = true;
        this.status = '選択したルールを作成しています…';
        try {
            const existing = await this.loadAllRules();
            let created = false;
            for (const item of this.items)
                for (const choice of item.choices) {
                    if (!choice.selected || (choice.result && choice.result !== 'failed')) continue;
                    choice.result = '';
                    if (hasDuplicateRule(existing, choice.rule)) {
                        choice.result = 'exists';
                        choice.detail = '同じキーワード・チャンネル・曜日・時刻のルールがあります';
                        continue;
                    }
                    try {
                        choice.result = 'creating';
                        choice.detail = '';
                        const added: any = await this.ruleApi.add(choice.rule);
                        const id = typeof added === 'object' ? added.ruleId : added;
                        existing.push({ id, ...choice.rule });
                        choice.result = 'created';
                        choice.detail = `ルール ID: ${id}`;
                        created = true;
                        this.$emit('created');
                    } catch (err: any) {
                        choice.result = 'failed';
                        choice.detail = this.message(err);
                    }
                }
            if (created) {
                try {
                    await this.refreshLinkedRules();
                } catch {
                    // 予約件数の再読み込みに失敗しても作成結果は保持する
                }
            }
            this.status = '作成結果を表示しています。失敗した項目は再度作成できます。';
        } catch (err: any) {
            this.error = `既存ルールの確認に失敗しました: ${this.message(err)}`;
            this.status = 'ルールを作成できませんでした。再試行してください。';
        } finally {
            this.saving = false;
        }
    }

    public formatDate(timestamp: number): string {
        return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(
            new Date(timestamp),
        );
    }
    private async loadAllRules(): Promise<apid.Rule[]> {
        const rules: apid.Rule[] = [];
        for (;;) {
            const page = await this.ruleApi.gets({ offset: rules.length, limit: 500 });
            rules.push(...page.rules);
            if (rules.length >= page.total || page.rules.length === 0) break;
        }
        return rules;
    }
    private async refreshLinkedRules(): Promise<void> {
        this.applyLinkedRules(await this.loadAllRules());
    }
    private applyLinkedRules(existing: apid.Rule[]): void {
        this.linkedRules = new Map(existing.filter(rule => typeof rule.bangumiId === 'number').map(rule => [rule.bangumiId as number, rule]));
        this.existingBangumiIds = new Set(this.linkedRules.keys());
        for (const item of this.items) {
            item.alreadyLinked = this.linkedRules.has(item.subject.id);
            item.linkedReserves = this.linkedRules.get(item.subject.id)?.reservesCnt ?? null;
        }
    }
    private restore(): void {
        const cache = scanCache;
        if (cache === null || cache.items.length === 0 || cache.quarter !== this.quarter || cache.user !== this.user) return;
        this.restoring = true;
        try {
            this.items = cache.items.map(item => JSON.parse(JSON.stringify(item)) as Item);
            for (const item of this.items) item.searching = false;
        } finally {
            this.restoring = false;
        }
        this.restored = true;
        this.restoredInfo = `${this.formatCacheDate(cache.savedAt)} に照合した ${this.items.length} 作品`;
        this.status = '前回の照合結果を表示しています。番組表を照合で取り直せます。';
    }
    private persist(): void {
        if (this.items.length === 0) {
            scanCache = null;
            return;
        }
        const user = this.user || '';
        const keepStamp = scanCache !== null && scanCache.quarter === this.quarter && scanCache.user === user ? scanCache.savedAt : Date.now();
        scanCache = {
            user,
            quarter: this.quarter,
            savedAt: keepStamp,
            items: this.items.map(item => JSON.parse(JSON.stringify({ ...item, searching: false })) as Item),
        };
    }
    private formatCacheDate(timestamp: number): string {
        return new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
    }
    public directoryRule(value: string): true | string {
        return isValidDirectory(value) || '保存先は空欄・絶対パス・親ディレクトリ参照を使えません';
    }
    public resetDirectory(choice: Choice): void {
        if (this.busy || choice.result === 'created' || choice.result === 'exists') return;
        choice.rule.saveOption.directory = choice.defaultDirectory;
    }
    public cannotResetDirectory(choice: Choice): boolean {
        return this.busy || choice.rule.saveOption.directory === choice.defaultDirectory || choice.result === 'created' || choice.result === 'exists';
    }
    public formatTime(seconds: number): string {
        return `${String(Math.floor((seconds % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
    }
    public resultLabel(choice: Choice): string {
        const labels: Record<string, string> = { creating: '作成中', created: '作成済み', exists: '既存', failed: '失敗' };
        return `${labels[choice.result] || ''}${choice.detail ? `: ${choice.detail}` : ''}`;
    }
    private message(err: any): string {
        return err?.response?.data?.message || err?.message || '不明なエラー';
    }
}
</script>

<style scoped>
.status-slot {
    min-height: 2.5em;
    padding-top: 8px;
}
.help-note {
    padding-left: 18px;
    line-height: 1.7;
    color: rgba(128, 128, 128, 1);
}
.subject-row + .subject-row {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
}
.subject-row {
    padding-top: 8px !important;
    padding-bottom: 8px !important;
}
.subject-details {
    min-width: 0;
    overflow-wrap: anywhere;
}
.subject-collapse ::v-deep .v-expansion-panel-content__wrap {
    padding-top: 0;
}
.choice-row {
    margin: 2px 0 0 8px;
}
.candidate-checkbox {
    min-height: 30px;
}
.choice-detail {
    margin-left: 32px;
    overflow-wrap: anywhere;
}
.path-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
}
.path-field {
    flex: 1;
    min-width: 0;
}
.path-reset {
    flex: none;
    margin-top: 7px;
}
.validation-slot {
    min-height: 1.5em;
}
.name-cn {
    font-family: 'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
.confirm-btn {
    min-width: 260px;
}
.confirm-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 20px;
}
.cover {
    width: 44px;
    height: 62px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: gray;
    background: rgba(128, 128, 128, 0.1);
}
.cover img {
    width: 100%;
    height: 100%;
    object-fit: contain;
}
</style>
