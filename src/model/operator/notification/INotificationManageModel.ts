import Recorded from '../../../db/entities/Recorded';

export default interface INotificationManageModel {
    addRecordingFinish(recorded: Recorded): void;
    addRecordingFailed(recorded: Recorded): void;
}
