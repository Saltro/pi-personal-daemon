import { writeParentNotification } from './session-callbacks.js';
import { putSession, type PersonalSessionRecord } from './session-registry.js';
import type { AppConfig } from './types.js';

export async function returnSessionCompletion(config: AppConfig, record: PersonalSessionRecord): Promise<PersonalSessionRecord> {
  if (!record.autoReturn) return record;
  const file = writeParentNotification(config, record);
  if (file) record.parentNotificationPath = file;
  else record.error = 'return failed: parent callback metadata missing';
  return putSession(config, record);
}
