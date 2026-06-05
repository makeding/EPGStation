import { Operation } from 'express-openapi';
import * as apid from '../../../../api';
import IScheduleApiModel from '../../api/schedule/IScheduleApiModel';
import container from '../../ModelContainer';
import ChannelTypeUtil from '../../../util/ChannelTypeUtil';
import * as api from '../api';

export const get: Operation = async (req, res) => {
    const scheduleApiModel = container.get<IScheduleApiModel>('IScheduleApiModel');

    try {
        const option = {
            startAt: parseInt(req.query.startAt as any, 10),
            endAt: parseInt(req.query.endAt as any, 10),
            isHalfWidth: req.query.isHalfWidth as any,
            needsRawExtended: req.query.needsRawExtended as any,
        } as apid.ScheduleOption;
        for (const type of ChannelTypeUtil.CHANNEL_TYPES) {
            option[type] = req.query[type] as any;
        }
        if (typeof req.query.isFree === 'boolean') {
            option.isFree = req.query.isFree;
        }
        api.responseJSON(res, 200, await scheduleApiModel.getSchedules(option));
    } catch (err: any) {
        api.responseServerError(res, err.message);
    }
};

get.apiDoc = {
    summary: '番組表情報取得',
    tags: ['schedules'],
    description: '番組表情報を取得する',
    parameters: [
        {
            $ref: '#/components/parameters/StartAt',
        },
        {
            $ref: '#/components/parameters/EndAt',
        },
        {
            $ref: '#/components/parameters/IsHalfWidth',
        },
        {
            $ref: '#/components/parameters/NeedsRawExtended',
        },
        {
            $ref: '#/components/parameters/IsFreeProgram',
        },
        {
            $ref: '#/components/parameters/requiredGR',
        },
        {
            $ref: '#/components/parameters/requiredGRALT',
        },
        {
            $ref: '#/components/parameters/requiredBS',
        },
        {
            $ref: '#/components/parameters/requiredBS4K',
        },
        {
            $ref: '#/components/parameters/requiredCS',
        },
        {
            $ref: '#/components/parameters/requiredSKY',
        },
        {
            $ref: '#/components/parameters/requiredNW1',
        },
        {
            $ref: '#/components/parameters/requiredNW2',
        },
        {
            $ref: '#/components/parameters/requiredNW3',
        },
        {
            $ref: '#/components/parameters/requiredNW4',
        },
        {
            $ref: '#/components/parameters/requiredNW5',
        },
        {
            $ref: '#/components/parameters/requiredNW6',
        },
        {
            $ref: '#/components/parameters/requiredNW7',
        },
        {
            $ref: '#/components/parameters/requiredNW8',
        },
        {
            $ref: '#/components/parameters/requiredNW9',
        },
        {
            $ref: '#/components/parameters/requiredNW10',
        },
        {
            $ref: '#/components/parameters/requiredNW11',
        },
        {
            $ref: '#/components/parameters/requiredNW12',
        },
        {
            $ref: '#/components/parameters/requiredNW13',
        },
        {
            $ref: '#/components/parameters/requiredNW14',
        },
        {
            $ref: '#/components/parameters/requiredNW15',
        },
        {
            $ref: '#/components/parameters/requiredNW16',
        },
        {
            $ref: '#/components/parameters/requiredNW17',
        },
        {
            $ref: '#/components/parameters/requiredNW18',
        },
        {
            $ref: '#/components/parameters/requiredNW19',
        },
        {
            $ref: '#/components/parameters/requiredNW20',
        },
        {
            $ref: '#/components/parameters/requiredNW21',
        },
        {
            $ref: '#/components/parameters/requiredNW22',
        },
        {
            $ref: '#/components/parameters/requiredNW23',
        },
        {
            $ref: '#/components/parameters/requiredNW24',
        },
        {
            $ref: '#/components/parameters/requiredNW25',
        },
        {
            $ref: '#/components/parameters/requiredNW26',
        },
        {
            $ref: '#/components/parameters/requiredNW27',
        },
        {
            $ref: '#/components/parameters/requiredNW28',
        },
        {
            $ref: '#/components/parameters/requiredNW29',
        },
        {
            $ref: '#/components/parameters/requiredNW30',
        },
        {
            $ref: '#/components/parameters/requiredNW31',
        },
        {
            $ref: '#/components/parameters/requiredNW32',
        },
        {
            $ref: '#/components/parameters/requiredNW33',
        },
        {
            $ref: '#/components/parameters/requiredNW34',
        },
        {
            $ref: '#/components/parameters/requiredNW35',
        },
        {
            $ref: '#/components/parameters/requiredNW36',
        },
        {
            $ref: '#/components/parameters/requiredNW37',
        },
        {
            $ref: '#/components/parameters/requiredNW38',
        },
        {
            $ref: '#/components/parameters/requiredNW39',
        },
        {
            $ref: '#/components/parameters/requiredNW40',
        },
    ],
    responses: {
        200: {
            description: '番組表情報を取得しました',
            content: {
                'application/json': {
                    schema: {
                        $ref: '#/components/schemas/Schedules',
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
