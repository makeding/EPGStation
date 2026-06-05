import * as apid from '../../api';

namespace ChannelTypeUtil {
    export const CHANNEL_TYPES: apid.ChannelType[] = [
        'GR',
        'GR-ALT',
        'BS',
        'BS4K',
        'CS',
        'SKY',
        ...Array.from({ length: 40 }, (_, i) => `NW${i + 1}` as apid.ChannelType),
    ];

    export const createBroadcastStatus = (): apid.BroadcastStatus => {
        const status = {} as apid.BroadcastStatus;

        for (const type of CHANNEL_TYPES) {
            status[type] = false;
        }

        return status;
    };

    export const getSelectedChannelTypes = (option: apid.ScheduleOption): apid.ChannelType[] => {
        return CHANNEL_TYPES.filter(type => option[type] === true);
    };
}

export default ChannelTypeUtil;
