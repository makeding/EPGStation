<template>
    <v-card outlined class="mb-5">
        <v-card-title>Bangumi 四半期作品からルールを作成</v-card-title>
        <v-card-text>
            <p>「見てる」のアニメを番組表と照合します。確認するまでルールは作成されません。アカウント名はこのブラウザに保存します。</p>
            <v-row align="center">
                <v-col cols="12" sm="5"><v-text-field v-model.trim="user" label="Bangumi アカウント" :disabled="busy" hide-details="auto"></v-text-field></v-col>
                <v-col cols="12" sm="4"><v-select v-model="quarter" :items="quarters" label="対象四半期" :disabled="busy" hide-details="auto"></v-select></v-col>
                <v-col cols="12" sm="3"><v-btn color="primary" block :loading="scanning" :disabled="busy || !user" v-on:click="scan">番組表を照合</v-btn></v-col>
            </v-row>
            <div class="status-slot" role="status" aria-live="polite">{{ status }}</div>
            <v-alert v-if="error" type="error" outlined dense>
                {{ error }}
                <span>アカウント名と通信状態を確認し、再度照合してください。</span>
            </v-alert>
            <template v-if="items.length">
                <v-divider class="mb-3"></v-divider>
                <div v-for="item in items" :key="item.subject.id" class="subject-row py-3">
                    <div class="d-flex">
                        <div class="cover mr-3">
                            <img v-if="item.subject.coverUrl" :src="item.subject.coverUrl" :alt="`${item.subject.name} の表紙`" v-on:error="item.subject.coverUrl = ''" />
                            <span v-else>表紙なし</span>
                        </div>
                        <div>
                            <div class="font-weight-medium">
                                {{ item.subject.name }}
                                <span v-if="item.subject.nameCn">/ {{ item.subject.nameCn }}</span>
                            </div>
                            <div class="caption">
                                放送開始: {{ item.subject.date || '日付不明' }}
                                <span v-if="item.reason">— {{ item.reason }}</span>
                            </div>
                        </div>
                    </div>
                    <div v-for="(choice, index) in item.choices" :key="index" class="choice-row">
                        <v-checkbox v-model="choice.selected" :disabled="saving || choice.result === 'created' || choice.result === 'exists'" class="mt-1" hide-details>
                            <template v-slot:label>
                                <span>
                                    {{ choice.candidate.program.name }} · {{ choice.channelLabel }} · {{ formatDate(choice.candidate.program.startAt) }} ·
                                    {{ formatTime(choice.candidate.startSeconds) }}–{{ formatTime(choice.candidate.startSeconds + 7200) }}
                                </span>
                            </template>
                        </v-checkbox>
                        <div class="caption choice-detail">
                            検索: {{ item.keyword }} · 保存先: {{ choice.rule.saveOption.directory }}
                            <span v-if="choice.result" :class="choice.result === 'failed' ? 'error--text' : 'success--text'">· {{ resultLabel(choice) }}</span>
                        </div>
                    </div>
                </div>
                <v-btn color="primary" :loading="saving" :disabled="busy || selectedCount === 0" v-on:click="confirm">選択した {{ selectedCount }} 件のルールを作成</v-btn>
                <span class="ml-3 caption">BS 放送の候補を初期選択しています。チェックを変更できます。</span>
            </template>
        </v-card-text>
    </v-card>
</template>

<script lang="ts">
import { Component, Vue } from 'vue-property-decorator';
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
    fetchBangumiWatching,
    filterQuarter,
    hasDuplicateRule,
    nextQuarter,
    searchTitle,
} from '@/lib/bangumiImport.mjs';

interface Choice {
    candidate: Candidate;
    rule: apid.AddRuleOption;
    channelLabel: string;
    selected: boolean;
    result: '' | 'created' | 'exists' | 'failed';
    detail: string;
}
interface Item {
    subject: BangumiSubject;
    keyword: string;
    reason: string;
    choices: Choice[];
}

@Component
export default class BangumiQuarterImport extends Vue {
    public user = '';
    public quarter = nextQuarter();
    public scanning = false;
    public saving = false;
    public status = '';
    public error = '';
    public items: Item[] = [];

    private ruleApi = container.get<IRuleApiModel>('IRuleApiModel');
    private scheduleApi = container.get<IScheduleApiModel>('IScheduleApiModel');
    private channelsApi = container.get<IChannelsApiModel>('IChannelsApiModel');
    private storage = container.get<IStorageOperationModel>('IStorageOperationModel');

    get busy(): boolean {
        return this.scanning || this.saving;
    }
    get selectedCount(): number {
        return this.items.reduce((count, item) => count + item.choices.filter(choice => choice.selected && (!choice.result || choice.result === 'failed')).length, 0);
    }
    get quarters(): Array<{ text: string; value: string }> {
        const today = new Date();
        const year = today.getFullYear();
        const starts = [year - 1, year, year + 1, year + 2].flatMap(y => [1, 4, 7, 10].map(m => `${y}-${String(m).padStart(2, '0')}`));
        return starts.map(value => ({ value, text: `${value.slice(0, 4)}年 第${(Number(value.slice(5)) + 2) / 3}四半期` }));
    }

    public created(): void {
        this.user = this.storage.get('bangumi-quarter-user') || '';
    }

    public async scan(): Promise<void> {
        if (this.busy || !this.user) return;
        this.scanning = true;
        this.error = '';
        this.items = [];
        this.status = 'Bangumi と番組表を照合しています…';
        try {
            const subjects = filterQuarter(await fetchBangumiWatching(this.user), this.quarter);
            this.storage.set('bangumi-quarter-user', this.user);
            if (!subjects.length) {
                this.status = '対象期間の「見てる」作品はありません。';
                return;
            }
            const channels = new Map((await this.channelsApi.getChannels()).map(channel => [channel.id, channel]));
            const items: Item[] = [];
            for (const subject of subjects) {
                const item: Item = { subject, keyword: '', reason: '', choices: [] };
                items.push(item);
                if (!subject.date) {
                    item.reason = '放送開始日が不明のため自動選択しません';
                    continue;
                }
                if (!subject.name) {
                    item.reason = '作品名がありません';
                    continue;
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
                        continue;
                    }
                    const defaults = defaultCandidateIndices(groups, channels);
                    item.choices = groups.map((candidate, index) => {
                        const channel = channels.get(candidate.channelId);
                        return {
                            candidate,
                            channelLabel: channel ? `${channel.remoteControlKeyId ?? channel.channel} ${channel.name}` : `ch:${candidate.channelId}`,
                            rule: createRule(subject, found.keyword, candidate, channel, this.quarter),
                            selected: defaults.includes(index),
                            result: '',
                            detail: '',
                        };
                    });
                } catch (err: any) {
                    item.reason = `番組表の検索に失敗: ${this.message(err)}`;
                }
            }
            this.items = items;
            this.status = `${items.length} 作品を確認しました。候補を選んでルールを作成できます。`;
        } catch (err: any) {
            this.error = `照合に失敗しました: ${this.message(err)}`;
            this.status = '照合を完了できませんでした。';
        } finally {
            this.scanning = false;
        }
    }

    public async confirm(): Promise<void> {
        if (this.busy || !this.selectedCount) return;
        this.saving = true;
        this.status = '選択したルールを作成しています…';
        try {
            const all = await this.ruleApi.gets({ limit: 10000 });
            const existing = all.rules;
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
                        const added: any = await this.ruleApi.add(choice.rule);
                        const id = typeof added === 'object' ? added.ruleId : added;
                        existing.push({ id, ...choice.rule });
                        choice.result = 'created';
                        choice.detail = `ルール ID: ${id}`;
                        this.$emit('created');
                    } catch (err: any) {
                        choice.result = 'failed';
                        choice.detail = this.message(err);
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
    public formatTime(seconds: number): string {
        return `${String(Math.floor((seconds % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
    }
    public resultLabel(choice: Choice): string {
        const labels: Record<string, string> = { created: '作成済み', exists: '既存', failed: '失敗' };
        return `${labels[choice.result] || ''}: ${choice.detail}`;
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
.subject-row + .subject-row {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
}
.choice-row {
    margin-left: 12px;
}
.choice-detail {
    margin-left: 32px;
    overflow-wrap: anywhere;
}
.cover {
    width: 60px;
    height: 84px;
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
