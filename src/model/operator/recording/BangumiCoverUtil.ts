import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_BYTES = 5 * 1024 * 1024;
const inProgress = new Set<string>();

/** Save a Bangumi cover alongside the first recording made by an imported rule. */
export async function saveBangumiCover(
    directory: string,
    bangumiId: number,
    request: typeof fetch = fetch,
): Promise<void> {
    if (!Number.isSafeInteger(bangumiId) || bangumiId < 1 || inProgress.has(directory)) {
        return;
    }
    inProgress.add(directory);
    try {
        for (const extension of ['jpg', 'png', 'webp']) {
            try {
                await fs.access(path.join(directory, `cover.${extension}`));
                return;
            } catch (err: any) {
                if (err.code !== 'ENOENT') throw err;
            }
        }

        const metadata = await request(`https://api.bgm.tv/v0/subjects/${bangumiId}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'EPGStation/2.10 (Bangumi cover)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!metadata.ok) throw new Error(`Bangumi metadata HTTP ${metadata.status}`);
        const subject = (await metadata.json()) as { images?: { large?: string; common?: string } };
        const url = new URL(subject.images?.large || subject.images?.common || '');
        if (url.protocol !== 'https:' || url.hostname !== 'lain.bgm.tv') {
            throw new Error('Unexpected Bangumi cover URL');
        }
        const image = await request(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (!image.ok || image.body === null) throw new Error(`Bangumi cover HTTP ${image.status}`);
        const type = image.headers.get('content-type')?.split(';')[0].trim();
        const extension =
            type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : null;
        if (extension === null) throw new Error('Unexpected Bangumi cover content type');
        const reader = image.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) throw new Error('Bangumi cover exceeds 5 MiB');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        if (size === 0) throw new Error('Bangumi cover is empty');
        try {
            await fs.writeFile(path.join(directory, `cover.${extension}`), Buffer.concat(chunks), { flag: 'wx' });
        } catch (err: any) {
            if (err.code !== 'EEXIST') throw err;
        }
    } finally {
        inProgress.delete(directory);
    }
}
