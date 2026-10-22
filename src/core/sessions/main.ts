import { MAIN_SESSION_ID } from '../../config.js';
import type { AppConfig } from '../../types.js';
import { getStateDb, readStateMeta, writeStateMeta } from '../state/db.js';
import {
  getSession,
  insertSession,
  loadRegistry,
  newSessionRecord,
  type PersonalSessionRecord,
} from './registry.js';

const MAIN_SESSION_META_KEY = 'main-session-id';

function readMainSessionId(config: AppConfig): string {
  return readStateMeta(getStateDb(config), MAIN_SESSION_META_KEY) || MAIN_SESSION_ID;
}

export function selectMainSession(config: AppConfig, id: string): PersonalSessionRecord {
  const record = getSession(config, id);
  writeStateMeta(getStateDb(config), MAIN_SESSION_META_KEY, record.id);
  return record;
}

/** The main session is a normal session record; the fixed default is created on demand. */
export function mainSessionRecord(config: AppConfig): PersonalSessionRecord {
  const id = readMainSessionId(config);
  const existing = loadRegistry(config).sessions[id];
  if (existing) return existing;
  if (id !== MAIN_SESSION_ID) throw new Error(`main session not found: ${id}`);
  try {
    return insertSession(config, newSessionRecord(config, { id, name: 'main', autoReturn: false }));
  } catch (error) {
    const concurrent = loadRegistry(config).sessions[id];
    if (concurrent) return concurrent;
    throw error;
  }
}
