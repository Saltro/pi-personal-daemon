import { writeParentNotification } from './session-callbacks.js';
import { putSession, type PersonalSessionRecord } from './session-registry.js';
import type { AppConfig } from './types.js';

export async function notifySessionCompletion(config: AppConfig, record: PersonalSessionRecord): Promise<PersonalSessionRecord> {
  if (!record.notify) return record;
  const file = writeParentNotification(config, record);
  if (file) record.parentNotificationPath = file;
  else record.error = 'notify failed: parent callback metadata missing';
  return putSession(config, record);
}
