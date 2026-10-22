import type { AppConfig } from '../../types.js';
import { writeParentNotification } from './callbacks.js';
import { type PersonalSessionRecord, putSession } from './registry.js';

export async function returnSessionCompletion(
  config: AppConfig,
  record: PersonalSessionRecord,
): Promise<PersonalSessionRecord> {
  if (!record.autoReturn) return record;
  const file = writeParentNotification(config, record);
  if (file) record.parentNotificationPath = file;
  else record.error = 'return failed: parent callback metadata missing';
  return putSession(config, record);
}
