import { Operation } from 'express-openapi';
import IChannelApiModel from '../../api/channel/IChannelApiModel.js';
import container from '../../ModelContainer.js';
import * as api from '../api.js';

/** `GET /channels` ハンドラ。`IChannelApiModel#getChannels` で放送局情報一覧を返す。 */
export const get: Operation = async (req, res) => {
    const channelApiModel = container.get<IChannelApiModel>('IChannelApiModel');

    try {
        const rawChannelId = req.query.channelId;
        const channelId =
            typeof rawChannelId === 'number'
                ? rawChannelId
                : typeof rawChannelId === 'string'
                  ? parseInt(rawChannelId, 10)
                  : undefined;
        api.responseJSON(res, 200, await channelApiModel.getChannels(channelId));
    } catch (err: any) {
        api.responseServerError(res, err.message);
    }
};

get.apiDoc = {
    summary: '放送局情報取得',
    tags: ['channels'],
    description: '放送局情報を取得する',
    parameters: [
        {
            name: 'channelId',
            in: 'query',
            required: false,
            description: '放送局のID',
            schema: { type: 'integer' },
        },
    ],
    responses: {
        200: {
            description: '放送局情報を取得しました',
            content: {
                'application/json': {
                    schema: {
                        $ref: '#/components/schemas/ChannelItems',
                    },
                },
            },
        },
        default: {
            description: '予期しないエラー',
            content: {
                'application/json': {
                    schema: {
                        $ref: '#/components/schemas/Error',
                    },
                },
            },
        },
    },
};
