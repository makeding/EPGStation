import Recorded from '../../../db/entities/Recorded';
import { StorageWarning } from '../../IConfigFile';

export default interface INotificationManageModel {
    addRecordingStart(recorded: Recorded): void;
    addRecordingFinish(recorded: Recorded): void;
    addRecordingFailed(recorded: Recorded): void;
    addStorageWarning(warning: StorageWarning): void;
}
