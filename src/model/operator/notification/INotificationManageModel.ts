import Recorded from '../../../db/entities/Recorded';

export default interface INotificationManageModel {
    addRecordingStart(recorded: Recorded): void;
    addRecordingFinish(recorded: Recorded): void;
    addRecordingFailed(recorded: Recorded): void;
}
