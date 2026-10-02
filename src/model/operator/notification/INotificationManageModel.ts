import Recorded from '../../../db/entities/Recorded';
import Reserve from '../../../db/entities/Reserve';
import { StorageWarning } from '../../IConfigFile';

export default interface INotificationManageModel {
    addRecordingPreStart(reserve: Reserve): void;
    addRecordingStart(recorded: Recorded): void;
    addRecordingFinish(recorded: Recorded): void;
    addRecordingFailed(recorded: Recorded): void;
    addRecordingPrepFailed(reserve: Reserve): void;
    addRecordingRetryOver(reserve: Reserve): void;
    addStorageWarning(warning: StorageWarning): void;
}
