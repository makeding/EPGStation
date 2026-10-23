# チューナーストリーム形式の選択

EPGStation は、視聴および通常録画で TS を必要とするため、サービス/番組ストリームに `format=ts` を要求する。BS4K の `recordedBS4KFormat: mmts` は、対応 Mirakurun へ `decode=1&format=tlv` を要求し、B61 解読済みの TLV を `.mmts` として保存する。

要求前に `/api/docs` の Swagger 2.0 定義を最大 2 秒読み、`/services/{id}/stream` と `/programs/{id}/stream` の両方が `format` query parameter の `ts` と `tlv` を列挙している時だけ `format` を送る。この結果は 60 秒だけ保持する。通信失敗・timeout・不正な文書は保持せず、次の要求で再確認する。旧 Mirakurun または mirakc では従来の `decode` だけの URL を使う。MMTS の旧サーバー向け回退は `decode=0`、TS の回退は `decode=1` である。

`decode` と `format` は独立した指定である。raw TLV の保管が必要な呼び出しは `decode: false, format: 'tlv'` を指定でき、対応しないサーバーに対する従来値は `legacyDecode` で明示する。呼び出し側のキャンセルは共有している文書取得を中断せず、当該要求だけを直ちに中止する。HTTP 406 など、対応を宣言したサーバーのストリーム要求失敗は別形式や旧 URL に再試行しない。

この動作は jp-dtv-4k/DMirakurun `9df3f5b` と Mirakurun `846bfb7` / `775e35e` を参照する。
