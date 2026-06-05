import * as apid from '../../../api';

namespace ChannelTypeUtil {
    export const CHANNEL_TYPES: apid.ChannelType[] = ['GR', 'GR-ALT', 'BS', 'BS4K', 'CS', 'SKY', ...Array.from({ length: 40 }, (_, i) => `NW${i + 1}` as apid.ChannelType)];

    export const getEnabledChannelTypes = (broadcast: apid.BroadcastStatus): apid.ChannelType[] => {
        return CHANNEL_TYPES.filter(type => broadcast[type] === true);
    };
}

export default ChannelTypeUtil;
