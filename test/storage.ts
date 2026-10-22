import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  claimCronRun,
  deleteCron,
  finishCronRun,
  getCron,
  loadCronRegistry,
  makeRuntimeCron,
  patchCron,
  patchCronRun,
  putCron,
  recoverRunningCrons,
  saveCronRegistry,
} from '../src/core/cron/registry.js';
import {
  agentProcessDetached,
  agentProcessGroupAlive,
} from '../src/core/runtime/process-control.js';
import {
  acknowledgeParentNotification,
  callbackQueuePath,
  claimParentNotifications,
  drainParentNotifications,
  listParentNotifications,
  noticeToInbound,
  recoverParentNotifications,
  releaseParentNotification,
  writeParentNotification,
  writeParentReturnNotification,
} from '../src/core/sessions/callbacks.js';
import {
  claimSessionRun,
  finishSessionRun,
  finishSessionRunAndReturn,
  getSession,
  insertSession,
  loadRegistry,
  newSessionRecord,
  putSession,
  refreshSessionStatus,
  saveRegistry,
  updateSessionRun,
} from '../src/core/sessions/registry.js';
import {
  ensureFeishuChatBinding,
  readFeishuChatBinding,
  writeFeishuChatBinding,
} from '../src/core/state/binding.js';
import {
  readCurrentContext,
  recordContextSend,
  recordContextUsage,
  writeCurrentContext,
} from '../src/core/state/context.js';
import { closeStateDb, getStateDb, stateTransaction } from '../src/core/state/db.js';
import { defaultStateDir, stateDbPath, stateDir } from '../src/core/state/paths.js';
import type { AppConfig, InboundEvent } from '../src/types.js';

const worker = process.argv[2] === 'worker';
if (worker) {
  const action = process.argv[3];
  const config = JSON.parse(process.argv[4]) as AppConfig;
  const id = process.argv[5];
  if (action === 'context') {
    for (let i = 0; i < 80; i++) {
      recordContextSend(config, 'event-1');
      recordContextUsage(config, { text: `worker-${id}-${i}`, source: 'test' }, 'event-1');
    }
  } else if (action === 'sessions') {
    for (let i = 0; i < 40; i++) {
      const record = getSession(config, id);
      record.lastResult = `${id}:${i}`;
      putSession(config, record);
    }
  } else if (action === 'claim') {
    try {
      claimSessionRun(config, getSession(config, 'race'), `run-${id}`);
      process.stdout.write('claimed');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('session busy:')) throw error;
      process.stdout.write('busy');
    }
  } else if (action === 'cron-claim') {
    process.stdout.write(claimCronRun(config, 'race-cron') ? 'claimed' : 'busy');
  } else if (action === 'callbacks') {
    process.stdout.write(String(claimParentNotifications(config).length));
  } else if (action === 'initialize') {
    insertSession(config, newSessionRecord(config, { id: `init-${id}`, autoReturn: false }));
  } else if (action === 'default-import') {
    // This worker runs with HOME pointing to a new temporary directory. Assert
    // the path before opening anything so a missing override cannot touch user state.
    assert.equal(config.stateDir, undefined);
    assert.equal(stateDir(config), path.join(id, '.local', 'state', 'retriever'));
    const imported = getSession(config, 'legacy-child');
    assert.equal(imported.autoReturn, true);
    assert.equal(imported.logPath, path.join(stateDir(config), 'sessions', 'legacy-child.log'));
    assert.equal(getCron(config, 'legacy-cron').prompt, 'wake');
    assert.equal(readFeishuChatBinding(config)?.chatId, 'visible-fixed');
    assert.equal(listParentNotifications(config)[0].id, 'legacy-notice');
    const notice = claimParentNotifications(config)[0];
    acknowledgeParentNotification(config, notice.id);
    closeStateDb(config);
    assert.equal(
      listParentNotifications(config).length,
      0,
      'default-root retained notices import only once',
    );
    process.stdout.write('default-import-ok');
  }
  closeStateDb(config);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-storage-'));
  const configs: AppConfig[] = [];
  const configFor = (name: string): AppConfig => {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    const config: AppConfig = {
      workspaceDir: root,
      extensions: { pi: { bin: 'pi', extraArgs: [] }, feishu: { appId: '', appSecret: '' } },
      sender: { type: 'mock', mockOutbox: path.join(root, 'outbox.jsonl') },
      stateDir: path.join(root, 'state'),
    };
    configs.push(config);
    return config;
  };
  const event: InboundEvent = {
    id: 'event-1',
    chatId: 'inbound-anywhere',
    source: 'test',
    kind: 'message',
    text: 'hello',
  };
  const writeJson = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const children = (action: string, config: AppConfig, ids: string[]): Promise<string[]> =>
    Promise.all(ids.map((id) => runWorker(action, config, id)));
  try {
    const legacy = configFor('legacy');
    const now = new Date().toISOString();
    const parent = {
      sessionId: 'old-parent',
      queuePath: callbackQueuePath(legacy, 'old-parent'),
      createdAt: now,
    };
    const { autoReturn: _legacyAutoReturn, ...legacySessionFields } = newSessionRecord(legacy, {
      id: 'legacy-child',
      autoReturn: true,
      parentCallback: parent,
    });
    const legacySession = { ...legacySessionFields, notify: 'parent', callback: 'obsolete' };
    const legacyCron = makeRuntimeCron({
      id: 'legacy-cron',
      prompt: 'wake',
      schedule: { type: 'cron', expression: '* * * * *' },
    });
    const legacyNotice = {
      type: 'session.return',
      id: 'legacy-notice',
      createdAt: now,
      parent,
      text: 'legacy result',
    };
    const sourceFiles = [
      path.join(stateDir(legacy), 'sessions', 'registry.json'),
      path.join(stateDir(legacy), 'cron', 'registry.json'),
      path.join(stateDir(legacy), 'feishu-chat-binding.json'),
      path.join(parent.queuePath, 'notice.json'),
    ];
    writeJson(sourceFiles[0], { sessions: { 'legacy-child': legacySession } });
    writeJson(sourceFiles[1], { version: 1, crons: { 'legacy-cron': legacyCron } });
    writeJson(sourceFiles[2], {
      chatId: 'visible-fixed',
      createdAt: now,
      updatedAt: now,
      source: 'legacy',
    });
    writeJson(sourceFiles[3], legacyNotice);
    fs.writeFileSync(legacySession.logPath, 'native session log retained');
    const original = sourceFiles.map((file) => fs.readFileSync(file, 'utf8'));
    assert.equal(getSession(legacy, 'legacy-child').autoReturn, true);
    assert.equal(
      'notify' in getSession(legacy, 'legacy-child'),
      false,
      'legacy notify is import-only',
    );
    assert.equal('callback' in getSession(legacy, 'legacy-child'), false);
    assert.equal(getCron(legacy, 'legacy-cron').prompt, 'wake');
    assert.equal(readFeishuChatBinding(legacy)?.chatId, 'visible-fixed');
    assert.deepEqual(listParentNotifications(legacy), [legacyNotice]);
    assert.equal(getStateDb(legacy).prepare('PRAGMA user_version').get()?.user_version, 3);
    const freshColumns = getStateDb(legacy)
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((column) => column.name);
    assert.ok(freshColumns.includes('autoReturn'));
    assert.equal(freshColumns.includes('notify'), false, 'new SQLite schema uses only autoReturn');
    assert.equal(getStateDb(legacy).prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(getStateDb(legacy).prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.ok(
      getStateDb(legacy).prepare("SELECT value FROM state_meta WHERE key='legacy-json-v1'").get(),
    );
    const notices = claimParentNotifications(legacy);
    acknowledgeParentNotification(legacy, notices[0].id);
    for (let i = 0; i < sourceFiles.length; i++)
      assert.equal(fs.readFileSync(sourceFiles[i], 'utf8'), original[i]);
    assert.equal(fs.readFileSync(legacySession.logPath, 'utf8'), 'native session log retained');
    closeStateDb(legacy);
    assert.equal(
      listParentNotifications(legacy).length,
      0,
      'retained legacy callback must not reimport after restart',
    );
    assert.equal(
      Number(getStateDb(legacy).prepare('SELECT count(*) AS n FROM sessions').get()?.n),
      1,
    );

    for (const version of [1, 2]) {
      const migration = configFor(`schema-v${version}`);
      fs.mkdirSync(path.dirname(stateDbPath(migration)), { recursive: true });
      const oldDb = new DatabaseSync(stateDbPath(migration));
      // Historical SQLite fixtures must use the real notify column, not autoReturn.
      oldDb.exec(`CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO state_meta VALUES ('legacy-json-v1', 'already-imported');
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, cwd TEXT NOT NULL, sessionDir TEXT, name TEXT,
          status TEXT NOT NULL CHECK(status IN ('idle','running','completed','failed')),
          pid INTEGER, watcherPid INTEGER, runId TEXT, agentProfile TEXT, agentProfileSnapshot TEXT,
          notify INTEGER NOT NULL CHECK(notify IN (0,1)), parentCallback TEXT, parentNotificationPath TEXT,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastPrompt TEXT, lastResult TEXT,
          logPath TEXT NOT NULL, exitCode INTEGER, error TEXT
        );
        CREATE TABLE crons (
          id TEXT PRIMARY KEY, prompt TEXT NOT NULL, scheduleType TEXT NOT NULL,
          scheduleValue TEXT NOT NULL, target TEXT NOT NULL, enabled INTEGER NOT NULL,
          status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          lastFiredAt TEXT, nextRunAt TEXT, lastError TEXT${version === 2 ? ', runId TEXT' : ''}
        ); PRAGMA user_version = ${version};`);
      const migrationParent = {
        sessionId: 'main',
        queuePath: callbackQueuePath(migration, 'main'),
        createdAt: now,
      };
      const migratedIds = [0, 1].map((value) => `v${version}-return-${value}`);
      for (const value of [0, 1]) {
        oldDb
          .prepare(
            'INSERT INTO sessions(id,sessionId,cwd,status,notify,parentCallback,agentProfile,agentProfileSnapshot,createdAt,updatedAt,lastResult,logPath) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            migratedIds[value],
            migratedIds[value],
            migration.workspaceDir,
            'completed',
            value,
            JSON.stringify(migrationParent),
            'saved-profile',
            JSON.stringify({ backend: 'mock' }),
            now,
            now,
            `preserved result ${value}`,
            path.join(stateDir(migration), 'sessions', `${migratedIds[value]}.log`),
          );
      }
      assert.deepEqual(
        oldDb
          .prepare('SELECT notify FROM sessions ORDER BY id')
          .all()
          .map((row) => row.notify),
        [0, 1],
      );
      const oldColumns = oldDb
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .map((column) => column.name);
      assert.ok(oldColumns.includes('notify'));
      assert.equal(oldColumns.includes('autoReturn'), false);
      const migrationDue = new Date(Date.now() - 1000).toISOString();
      const cronId = `v${version}-cron`;
      oldDb
        .prepare(
          'INSERT INTO crons(id,prompt,scheduleType,scheduleValue,target,enabled,status,createdAt,updatedAt,nextRunAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          cronId,
          `preserved v${version} prompt`,
          'at',
          migrationDue,
          'main',
          1,
          'scheduled',
          now,
          now,
          migrationDue,
        );
      oldDb.close();

      const migratedDb = getStateDb(migration);
      assert.equal(
        migratedDb.prepare('PRAGMA user_version').get()?.user_version,
        3,
        `v${version} migrates to v3`,
      );
      const migratedColumns = migratedDb
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .map((column) => column.name);
      assert.ok(migratedColumns.includes('autoReturn'));
      assert.equal(migratedColumns.includes('notify'), false);
      assert.deepEqual(
        migratedDb
          .prepare('SELECT autoReturn FROM sessions ORDER BY id')
          .all()
          .map((row) => row.autoReturn),
        [0, 1],
        'migration retains both stored booleans',
      );
      for (const value of [0, 1]) {
        const migrated = getSession(migration, migratedIds[value]);
        assert.equal(migrated.autoReturn, Boolean(value));
        assert.equal(Object.hasOwn(migrated, 'notify'), false);
        assert.equal(migrated.lastResult, `preserved result ${value}`);
        assert.equal(migrated.agentProfile, 'saved-profile');
        assert.deepEqual(migrated.agentProfileSnapshot, { backend: 'mock' });
        assert.deepEqual(migrated.parentCallback, migrationParent);
        assert.equal(migrated.createdAt, now);
      }
      assert.throws(
        () =>
          migratedDb.prepare('UPDATE sessions SET autoReturn = 2 WHERE id = ?').run(migratedIds[0]),
        /CHECK constraint failed/,
        'renamed boolean column retains its constraint',
      );
      assert.equal(getCron(migration, cronId).prompt, `preserved v${version} prompt`);
      const migratedClaim = claimCronRun(migration, cronId)!;
      assert.match(migratedClaim.runId!, /^[0-9a-f-]{36}$/);
      assert.ok(
        finishCronRun(migration, cronId, migratedClaim.runId!, {
          status: 'completed',
          enabled: false,
        }),
      );
      assert.equal(getCron(migration, cronId).runId, undefined);
      closeStateDb(migration);
      assert.equal(
        getStateDb(migration).prepare('PRAGMA user_version').get()?.user_version,
        3,
        'v3 schema reopens without repeated ALTER',
      );
      for (const value of [0, 1])
        assert.equal(getSession(migration, migratedIds[value]).autoReturn, Boolean(value));
      const changedReturn = getSession(migration, migratedIds[0]);
      changedReturn.autoReturn = true;
      putSession(migration, changedReturn);
      assert.equal(
        getSession(migration, changedReturn.id).autoReturn,
        true,
        'migrated records write through autoReturn',
      );
      assert.equal(
        getStateDb(migration)
          .prepare('SELECT autoReturn FROM sessions WHERE id = ?')
          .get(changedReturn.id)?.autoReturn,
        1,
      );
    }

    const legacyModes = configFor('legacy-return-modes');
    const legacyModeRegistry: Record<string, object> = {};
    const legacyModeCases = [
      { id: 'boolean-true', notify: true, expected: true },
      { id: 'boolean-false', notify: false, expected: false },
      { id: 'parent-mode', notify: 'parent', expected: true },
      { id: 'none-mode', notify: 'none', expected: false },
      { id: 'feishu-mode', notify: 'feishu', expected: false },
      { id: 'new-false-wins', notify: true, autoReturn: false, expected: false },
      { id: 'new-true-wins', notify: false, autoReturn: true, expected: true },
    ];
    for (const { id, expected: _expected, ...fields } of legacyModeCases) {
      const { autoReturn: _autoReturn, ...record } = newSessionRecord(legacyModes, {
        id,
        autoReturn: false,
      });
      legacyModeRegistry[id] = { ...record, ...fields };
    }
    const legacyModePath = path.join(stateDir(legacyModes), 'sessions', 'registry.json');
    writeJson(legacyModePath, { sessions: legacyModeRegistry });
    const originalModes = fs.readFileSync(legacyModePath, 'utf8');
    for (const { id, expected } of legacyModeCases) {
      const imported = getSession(legacyModes, id);
      assert.equal(imported.autoReturn, expected, `legacy return setting ${id}`);
      assert.equal(Object.hasOwn(imported, 'notify'), false);
    }
    assert.equal(
      fs.readFileSync(legacyModePath, 'utf8'),
      originalModes,
      'legacy setting imports leave original JSON unchanged',
    );

    const malformed = configFor('malformed');
    const { autoReturn: _goodAutoReturn, ...goodSessionFields } = newSessionRecord(malformed, {
      id: 'good',
      autoReturn: false,
    });
    const goodSession = { ...goodSessionFields, notify: false };
    writeJson(path.join(stateDir(malformed), 'sessions', 'registry.json'), {
      sessions: { good: goodSession },
    });
    const badCallback = path.join(callbackQueuePath(malformed, 'parent'), 'bad.json');
    writeJson(badCallback, { type: 'session.return', id: 'bad' });
    assert.throws(() => loadRegistry(malformed), /Legacy state import failed.*bad.json/);
    assert.ok(fs.existsSync(badCallback), 'malformed original must be retained');
    const inspect = new DatabaseSync(stateDbPath(malformed));
    assert.equal(
      inspect.prepare('PRAGMA user_version').get()?.user_version,
      0,
      'schema and import rollback together',
    );
    assert.equal(
      inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sessions'").get()?.n,
      0,
    );
    inspect.close();
    writeJson(badCallback, {
      type: 'session.return',
      id: 'fixed',
      createdAt: now,
      parent,
      text: 'fixed result',
    });
    assert.equal(getSession(malformed, 'good').id, 'good', 'corrected source can retry');
    const malformedRegistry = configFor('malformed-registry');
    const malformedRegistryPath = path.join(
      stateDir(malformedRegistry),
      'sessions',
      'registry.json',
    );
    writeJson(malformedRegistryPath, { sessions: [] });
    assert.throws(() => loadRegistry(malformedRegistry), /sessions must be an object/);
    assert.equal(fs.readFileSync(malformedRegistryPath, 'utf8'), '{"sessions":[]}');

    const simultaneousInit = configFor('simultaneous-init');
    await children('initialize', simultaneousInit, ['1', '2', '3', '4']);
    assert.equal(
      Object.keys(loadRegistry(simultaneousInit).sessions).length,
      4,
      'concurrent first opens serialize schema migration',
    );

    // Pure path assertions only: never open the actual default cache in this process.
    const contextOnly: AppConfig = { ...legacy, stateDir: undefined };
    assert.equal(stateDir(contextOnly), defaultStateDir());
    assert.equal(stateDbPath(contextOnly), path.join(defaultStateDir(), 'state.sqlite'));

    const tempHome = path.join(tmp, 'temporary-home');
    const oldDefaultRoot = path.join(tempHome, '.local', 'state', 'retriever');
    const homeParent = {
      ...parent,
      queuePath: path.join(oldDefaultRoot, 'session-callbacks', 'old-parent'),
    };
    const homeSession = {
      ...legacySession,
      parentCallback: homeParent,
      logPath: path.join(oldDefaultRoot, 'sessions', 'legacy-child.log'),
    };
    const homeSources = [
      path.join(oldDefaultRoot, 'sessions', 'registry.json'),
      path.join(oldDefaultRoot, 'cron', 'registry.json'),
      path.join(oldDefaultRoot, 'feishu-chat-binding.json'),
      path.join(homeParent.queuePath, 'notice.json'),
    ];
    writeJson(homeSources[0], { sessions: { 'legacy-child': homeSession } });
    writeJson(homeSources[1], { version: 1, crons: { 'legacy-cron': legacyCron } });
    writeJson(homeSources[2], { chatId: 'visible-fixed', createdAt: now, updatedAt: now });
    writeJson(homeSources[3], { ...legacyNotice, parent: homeParent });
    const homeOriginals = homeSources.map((file) => fs.readFileSync(file, 'utf8'));
    const homeConfig: AppConfig = { ...legacy, stateDir: undefined };
    assert.equal(
      await runWorker('default-import', homeConfig, tempHome, {
        HOME: tempHome,
        XDG_STATE_HOME: '',
      }),
      'default-import-ok',
    );
    for (let i = 0; i < homeSources.length; i++)
      assert.equal(fs.readFileSync(homeSources[i], 'utf8'), homeOriginals[i]);
    assert.ok(fs.existsSync(path.join(oldDefaultRoot, 'state.sqlite')));

    const isolatedA = configFor('isolated-a');
    const isolatedB = configFor('isolated-b');
    assert.notEqual(stateDbPath(isolatedA), stateDbPath(isolatedB));
    writeCurrentContext(isolatedA, event);
    assert.throws(() => readCurrentContext(isolatedB), /current message context not found/);
    const stateOnly = configFor('state-only');
    assert.throws(() => readCurrentContext(stateOnly), /current message context not found/);

    const context = configFor('context');
    writeCurrentContext(context, event);
    await children('context', context, ['a', 'b', 'c', 'd']);
    assert.equal(
      readCurrentContext(context).sendCount,
      320,
      'increments must survive independent writers and usage patches',
    );
    assert.match(readCurrentContext(context).contextUsage!, /^worker-/);
    recordContextUsage(context, { text: 'final usage', source: 'test' }, event.id);
    assert.equal(readCurrentContext(context).sendCount, 320);
    writeCurrentContext(context, { ...event, id: 'event-2' });
    assert.throws(() => recordContextSend(context, 'event-1'), /ownership changed/);
    assert.throws(
      () => recordContextUsage(context, { text: 'stale', source: 'test' }, 'event-1'),
      /ownership changed/,
    );
    assert.equal(readCurrentContext(context).sendCount, 0);
    assert.equal(readCurrentContext(context).contextUsage, undefined);
    assert.equal(
      recordContextSend(context).sendCount,
      1,
      'unguarded legacy call retains semantics',
    );

    const sessions = configFor('sessions');
    for (const id of ['a', 'b', 'c', 'd', 'race'])
      putSession(sessions, newSessionRecord(sessions, { id, autoReturn: false }));
    await children('sessions', sessions, ['a', 'b', 'c', 'd']);
    for (const id of ['a', 'b', 'c', 'd'])
      assert.equal(getSession(sessions, id).lastResult, `${id}:39`);
    const stale = getSession(sessions, 'a');
    const latest = getSession(sessions, 'a');
    latest.name = 'concurrent name';
    putSession(sessions, latest);
    stale.lastPrompt = 'independent field';
    putSession(sessions, stale);
    assert.equal(getSession(sessions, 'a').name, 'concurrent name');
    const staleRegistry = loadRegistry(sessions);
    putSession(sessions, newSessionRecord(sessions, { id: 'new-record', autoReturn: false }));
    staleRegistry.sessions.b.name = 'patched via registry';
    saveRegistry(sessions, staleRegistry);
    assert.equal(getSession(sessions, 'new-record').id, 'new-record');
    assert.equal(getSession(sessions, 'b').name, 'patched via registry');
    assert.throws(
      () => insertSession(sessions, newSessionRecord(sessions, { id: 'a', autoReturn: true })),
      /session already exists/,
    );
    assert.equal(getSession(sessions, 'a').autoReturn, false);
    const acquisition = await children('claim', sessions, ['1', '2', '3', '4']);
    assert.equal(acquisition.filter((result) => result === 'claimed').length, 1);
    const owned = getSession(sessions, 'race');
    assert.throws(() => claimSessionRun(sessions, owned, 'overlap'), /session busy/);
    assert.equal(
      updateSessionRun(sessions, 'race', 'stale-token', { status: 'completed' }),
      undefined,
    );
    assert.equal(getSession(sessions, 'race').status, 'running');
    finishSessionRun(sessions, 'race', owned.runId!, {
      status: 'completed',
      lastResult: 'done',
      watcherPid: 99999999,
    });
    assert.equal(getSession(sessions, 'race').runId, undefined);
    assert.equal(getSession(sessions, 'race').watcherPid, undefined);
    const next = claimSessionRun(sessions, getSession(sessions, 'race'), 'next-run');
    assert.equal(finishSessionRun(sessions, 'race', owned.runId!, { status: 'failed' }), undefined);
    assert.equal(getSession(sessions, 'race').runId, 'next-run');
    updateSessionRun(sessions, 'race', next.runId!, { pid: 99999999, watcherPid: process.pid });
    assert.equal(
      refreshSessionStatus(sessions, getSession(sessions, 'race')).status,
      'running',
      'live supervisor owns finalization even after child exit',
    );
    updateSessionRun(sessions, 'race', next.runId!, { watcherPid: undefined });
    const interrupted = refreshSessionStatus(sessions, getSession(sessions, 'race'));
    assert.equal(interrupted.status, 'failed');
    assert.match(interrupted.error!, /interrupted/);
    assert.equal(interrupted.runId, undefined);
    assert.equal(interrupted.pid, undefined);
    if (agentProcessDetached) await testOrphanedGroup(sessions);

    const binding = configFor('binding');
    assert.equal(ensureFeishuChatBinding(binding, 'first-chat').chatId, 'first-chat');
    const createdAt = readFeishuChatBinding(binding)!.createdAt;
    assert.equal(
      ensureFeishuChatBinding(binding, 'other-input-chat').chatId,
      'first-chat',
      'single visible binding remains fixed',
    );
    assert.equal(writeFeishuChatBinding(binding, 'manual-change').createdAt, createdAt);
    assert.equal(readFeishuChatBinding(binding)?.chatId, 'manual-change');

    const limitedCallback = configFor('limited-callbacks');
    const limitedParent = {
      sessionId: 'main',
      queuePath: callbackQueuePath(limitedCallback, 'main'),
      createdAt: now,
    };
    for (let i = 0; i < 4; i++)
      writeParentReturnNotification(limitedCallback, limitedParent, `limited ${i}`);
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => claimParentNotifications(limitedCallback, limit),
        /limit must be a positive integer/,
      );
    }
    const firstLimited = claimParentNotifications(limitedCallback, 1);
    assert.equal(firstLimited.length, 1);
    assert.equal(
      Number(
        getStateDb(limitedCallback)
          .prepare(
            "SELECT count(*) AS n FROM parent_notifications WHERE status='pending' AND attempts=0",
          )
          .get()?.n,
      ),
      3,
      'unclaimed backlog retains zero attempts',
    );
    assert.equal(
      Number(
        getStateDb(limitedCallback)
          .prepare(
            "SELECT count(*) AS n FROM parent_notifications WHERE status='claimed' AND attempts=1",
          )
          .get()?.n,
      ),
      1,
    );
    acknowledgeParentNotification(limitedCallback, firstLimited[0].id);
    assert.equal(claimParentNotifications(limitedCallback, 2).length, 2);
    assert.equal(
      Number(
        getStateDb(limitedCallback)
          .prepare(
            "SELECT count(*) AS n FROM parent_notifications WHERE status='pending' AND attempts=0",
          )
          .get()?.n,
      ),
      1,
    );
    assert.equal(
      claimParentNotifications(limitedCallback).length,
      1,
      'omitted limit still claims all eligible pending notices',
    );

    const callback = configFor('callbacks');
    const callbackParent = {
      sessionId: 'not-main',
      queuePath: callbackQueuePath(callback, 'not-main'),
      createdAt: now,
    };
    const ids = Array.from({ length: 30 }, (_, index) =>
      writeParentReturnNotification(callback, callbackParent, `result ${index}`, 'same-child'),
    );
    assert.equal(new Set(ids).size, 30, 'same millisecond and child must not overwrite notices');
    assert.equal(listParentNotifications(callback).length, 30);
    const callbackClaims = await children('callbacks', callback, ['a', 'b', 'c']);
    assert.equal(
      callbackClaims.map(Number).reduce((a, b) => a + b, 0),
      30,
    );
    assert.equal(
      claimParentNotifications(callback).length,
      0,
      'only pending notices can be claimed',
    );
    assert.equal(listParentNotifications(callback).length, 30, 'claims remain persisted');
    acknowledgeParentNotification(callback, ids[0]);
    closeStateDb(callback);
    assert.equal(recoverParentNotifications(callback), 29);
    assert.equal(
      claimParentNotifications(callback).length,
      0,
      'recovery uses persisted retry backoff',
    );
    getStateDb(callback)
      .prepare(
        "UPDATE parent_notifications SET availableAt='2000-01-01T00:00:00.000Z' WHERE status='pending'",
      )
      .run();
    const recovered = claimParentNotifications(callback);
    assert.equal(recovered.length, 29);
    for (const notice of recovered) releaseParentNotification(callback, notice.id);
    getStateDb(callback)
      .prepare(
        "UPDATE parent_notifications SET availableAt='2000-01-01T00:00:00.000Z' WHERE status='pending'",
      )
      .run();
    const lastAttempt = claimParentNotifications(callback);
    for (const notice of lastAttempt) releaseParentNotification(callback, notice.id);
    assert.equal(listParentNotifications(callback).length, 0);
    assert.equal(
      Number(
        getStateDb(callback)
          .prepare(
            "SELECT count(*) AS n FROM parent_notifications WHERE status='failed' AND attempts=3",
          )
          .get()?.n,
      ),
      29,
    );
    assert.equal(
      Number(
        getStateDb(callback)
          .prepare("SELECT count(*) AS n FROM parent_notifications WHERE status='delivered'")
          .get()?.n,
      ),
      1,
    );
    const freshId = writeParentReturnNotification(callback, callbackParent, 'fresh');
    assert.equal(drainParentNotifications(callback)[0].id, freshId);
    assert.equal(listParentNotifications(callback).length, 0);
    const completion = newSessionRecord(callback, {
      id: 'complete',
      autoReturn: true,
      parentCallback: callbackParent,
    });
    completion.status = 'completed';
    assert.ok(writeParentNotification(callback, completion));
    const completionNotice = claimParentNotifications(callback)[0];
    assert.equal(completionNotice.type, 'session.completed');
    assert.equal(noticeToInbound(completionNotice).source, 'session-callback');
    assert.equal(noticeToInbound(completionNotice).kind, 'wake');
    acknowledgeParentNotification(callback, completionNotice.id);
    const atomic = insertSession(
      callback,
      newSessionRecord(callback, {
        id: 'atomic',
        autoReturn: true,
        parentCallback: callbackParent,
        agentProfile: 'saved-profile',
        agentProfileSnapshot: { backend: 'mock' },
      }),
    );
    claimSessionRun(callback, atomic, 'atomic-run');
    assert.equal(
      finishSessionRunAndReturn(callback, atomic.id, 'old-token', { status: 'completed' }),
      undefined,
    );
    assert.equal(
      listParentNotifications(callback).length,
      0,
      'stale token cannot enqueue completion',
    );
    const finishedAtomic = finishSessionRunAndReturn(callback, atomic.id, 'atomic-run', {
      status: 'completed',
      lastResult: 'atomic result',
    })!;
    assert.equal(listParentNotifications(callback).length, 1);
    assert.equal(listParentNotifications(callback)[0].id, finishedAtomic.parentNotificationPath);
    assert.equal(finishedAtomic.agentProfile, 'saved-profile');
    assert.equal(finishedAtomic.agentProfileSnapshot?.backend, 'mock');
    assert.equal(
      finishSessionRunAndReturn(callback, atomic.id, 'atomic-run', { status: 'failed' }),
      undefined,
    );
    assert.equal(
      listParentNotifications(callback).length,
      1,
      'double finalization cannot duplicate callback',
    );
    drainParentNotifications(callback);
    const rollbackRecord = insertSession(
      callback,
      newSessionRecord(callback, {
        id: 'rollback-notice',
        autoReturn: true,
        parentCallback: callbackParent,
      }),
    );
    claimSessionRun(callback, rollbackRecord, 'rollback-run');
    getStateDb(callback).exec(
      "CREATE TRIGGER reject_notice BEFORE INSERT ON parent_notifications BEGIN SELECT RAISE(ABORT, 'test reject notice'); END",
    );
    assert.throws(
      () =>
        finishSessionRunAndReturn(callback, rollbackRecord.id, 'rollback-run', {
          status: 'completed',
        }),
      /test reject notice/,
    );
    assert.equal(
      getSession(callback, rollbackRecord.id).status,
      'running',
      'failed enqueue rolls back terminal session update',
    );
    getStateDb(callback).exec('DROP TRIGGER reject_notice');
    finishSessionRunAndReturn(callback, rollbackRecord.id, 'rollback-run', {
      status: 'failed',
      error: 'test failure',
    });
    drainParentNotifications(callback);
    const lostOwner = insertSession(
      callback,
      newSessionRecord(callback, {
        id: 'lost-owner',
        autoReturn: true,
        parentCallback: callbackParent,
      }),
    );
    claimSessionRun(callback, lostOwner, 'lost-run');
    updateSessionRun(callback, lostOwner.id, 'lost-run', { pid: 99999999 });
    assert.equal(
      refreshSessionStatus(callback, getSession(callback, lostOwner.id)).status,
      'failed',
    );
    assert.equal(
      listParentNotifications(callback).length,
      1,
      'interrupted repair atomically queues requested failure notice',
    );
    refreshSessionStatus(callback, getSession(callback, lostOwner.id));
    assert.equal(
      listParentNotifications(callback).length,
      1,
      'interrupted repair cannot duplicate notice',
    );
    drainParentNotifications(callback);

    const crons = configFor('crons');
    const due = new Date(Date.now() - 10_000).toISOString();
    putCron(
      crons,
      makeRuntimeCron({ id: 'race-cron', prompt: 'old prompt', schedule: { type: 'at', at: due } }),
    );
    const cronAcquisition = await children('cron-claim', crons, ['a', 'b', 'c']);
    assert.equal(cronAcquisition.filter((result) => result === 'claimed').length, 1);
    assert.equal(getCron(crons, 'race-cron').status, 'running');
    assert.equal(claimCronRun(crons, 'race-cron'), undefined);
    const claimedCronRunId = getCron(crons, 'race-cron').runId!;
    assert.match(claimedCronRunId, /^[0-9a-f-]{36}$/);
    assert.equal(
      patchCronRun(crons, 'race-cron', 'stale-token', { enabled: false, status: 'completed' }),
      undefined,
    );
    patchCron(crons, 'race-cron', { prompt: 'changed during run', target: 'new' });
    finishCronRun(crons, 'race-cron', claimedCronRunId, {
      enabled: false,
      status: 'completed',
      nextRunAt: undefined,
    });
    assert.equal(getCron(crons, 'race-cron').runId, undefined);
    assert.equal(
      finishCronRun(crons, 'race-cron', claimedCronRunId, { status: 'failed' }),
      undefined,
      'finished run cannot finalize twice',
    );
    assert.equal(getCron(crons, 'race-cron').prompt, 'changed during run');
    assert.equal(getCron(crons, 'race-cron').target, 'new');
    assert.equal(getCron(crons, 'race-cron').enabled, false);
    putCron(
      crons,
      makeRuntimeCron({
        id: 'reused-id',
        prompt: 'original dispatch',
        schedule: { type: 'at', at: due },
      }),
    );
    const originalClaim = claimCronRun(crons, 'reused-id')!;
    deleteCron(crons, 'reused-id');
    assert.equal(
      finishCronRun(crons, 'reused-id', originalClaim.runId!, {
        status: 'completed',
        enabled: false,
      }),
      undefined,
      'deleted cron has no matching run',
    );
    const recreated = putCron(
      crons,
      makeRuntimeCron({
        id: 'reused-id',
        prompt: 'replacement dispatch',
        target: 'new',
        schedule: { type: 'at', at: due },
      }),
    );
    assert.equal(
      finishCronRun(crons, 'reused-id', originalClaim.runId!, {
        status: 'completed',
        enabled: false,
      }),
      undefined,
      'old finalization cannot disable recreated scheduled cron',
    );
    assert.equal(getCron(crons, 'reused-id').enabled, true);
    assert.equal(getCron(crons, 'reused-id').prompt, recreated.prompt);
    const replacementClaim = claimCronRun(crons, 'reused-id')!;
    assert.notEqual(replacementClaim.runId, originalClaim.runId);
    assert.equal(
      finishCronRun(crons, 'reused-id', originalClaim.runId!, {
        status: 'failed',
        lastError: 'old error',
      }),
      undefined,
      'old finalization cannot affect new claimed run',
    );
    assert.equal(getCron(crons, 'reused-id').runId, replacementClaim.runId);
    assert.equal(getCron(crons, 'reused-id').status, 'running');
    assert.equal(getCron(crons, 'reused-id').lastError, undefined);
    assert.throws(
      () => patchCronRun(crons, 'reused-id', replacementClaim.runId!, { runId: 'override-token' }),
      /cannot replace/,
    );
    finishCronRun(crons, 'reused-id', replacementClaim.runId!, {
      status: 'completed',
      enabled: false,
    });
    assert.equal(getCron(crons, 'reused-id').runId, undefined);
    const recurring = putCron(
      crons,
      makeRuntimeCron({
        id: 'recurring',
        prompt: 'tick',
        schedule: { type: 'cron', expression: '* * * * *' },
      }),
    );
    patchCron(crons, recurring.id, { nextRunAt: due });
    assert.equal(
      loadCronRegistry(crons).crons.recurring.nextRunAt,
      due,
      'overdue recurring occurrence stays due',
    );
    assert.ok(claimCronRun(crons, recurring.id));
    putCron(
      crons,
      makeRuntimeCron({
        id: 'interrupted-once',
        prompt: 'once',
        schedule: { type: 'at', at: due },
      }),
    );
    assert.ok(claimCronRun(crons, 'interrupted-once'));
    assert.equal(recoverRunningCrons(crons), 2);
    for (const id of ['recurring', 'interrupted-once']) {
      const record = getCron(crons, id);
      assert.equal(record.status, 'failed');
      assert.equal(record.enabled, false);
      assert.equal(record.nextRunAt, undefined);
      assert.equal(record.runId, undefined, 'restart recovery clears interrupted execution token');
      assert.match(record.lastError!, /interrupted/);
      assert.equal(
        claimCronRun(crons, id),
        undefined,
        'interrupted effect never automatically replays',
      );
    }
    patchCron(crons, 'recurring', { enabled: true, status: 'scheduled', lastFiredAt: undefined });
    assert.equal(getCron(crons, 'recurring').enabled, true);
    assert.ok(Date.parse(getCron(crons, 'recurring').nextRunAt!) > Date.now());
    const cronView = loadCronRegistry(crons);
    putCron(
      crons,
      makeRuntimeCron({ id: 'concurrent-new', prompt: 'new', schedule: { type: 'at', at: due } }),
    );
    cronView.crons.recurring.prompt = 'registry patch';
    saveCronRegistry(crons, cronView);
    assert.equal(getCron(crons, 'concurrent-new').prompt, 'new');
    assert.equal(getCron(crons, 'recurring').prompt, 'registry patch');
    deleteCron(crons, 'concurrent-new');
    assert.throws(() => getCron(crons, 'concurrent-new'), /cron not found/);
    assert.throws(() => deleteCron(crons, 'concurrent-new'), /cron not found/);
    assert.throws(
      () =>
        stateTransaction(getStateDb(crons), () => {
          getStateDb(crons)
            .prepare("UPDATE crons SET prompt='rolled back' WHERE id='recurring'")
            .run();
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(getCron(crons, 'recurring').prompt, 'registry patch');

    console.log(
      'storage ok: transactional legacy import, independent writers, run tokens, singleton binding/context, callback retries and cron recovery',
    );
  } finally {
    for (const config of configs) closeStateDb(config);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testOrphanedGroup(config: AppConfig): Promise<void> {
  // Only signal the dedicated process group created by this test. The descendant
  // inherits the leader's group, then outlives its SIGKILL to reproduce stale PID.
  const leader = spawn(
    process.execPath,
    [
      '-e',
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child.once('spawn', () => { if (process.send) process.send({ ready: true }); });
    setInterval(() => {}, 1000);
  `,
    ],
    { detached: true, cwd: config.workspaceDir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('test process-group startup timed out')),
        5000,
      );
      leader.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      leader.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const pid = leader.pid!;
    const record = insertSession(
      config,
      newSessionRecord(config, { id: 'orphan-group', autoReturn: false }),
    );
    claimSessionRun(config, record, 'group-run');
    updateSessionRun(config, record.id, 'group-run', { pid, watcherPid: undefined });
    const exited = new Promise<void>((resolve) => leader.once('exit', () => resolve()));
    leader.kill('SIGKILL');
    await exited;
    assert.equal(agentProcessGroupAlive({ pid }), true, 'descendant remains in dead leader group');
    assert.equal(
      refreshSessionStatus(config, getSession(config, record.id)).status,
      'running',
      'PID repair must retain occupied session while descendants can write',
    );
    assert.throws(
      () => claimSessionRun(config, getSession(config, record.id), 'overlap'),
      /session busy/,
    );
    process.kill(-pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (agentProcessGroupAlive({ pid }) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      agentProcessGroupAlive({ pid }),
      false,
      'test group is gone before repair releases token',
    );
    assert.equal(refreshSessionStatus(config, getSession(config, record.id)).status, 'failed');
    assert.equal(getSession(config, record.id).runId, undefined);
  } finally {
    if (leader.pid) {
      try {
        process.kill(-leader.pid, 'SIGKILL');
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: unexpected kill failure must surface during cleanup
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (leader.connected) leader.disconnect();
  }
}

async function runWorker(
  action: string,
  config: AppConfig,
  id: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        'worker',
        action,
        JSON.stringify(config),
        id,
      ],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`storage worker ${action}/${id} exited ${code}: ${stderr}`)),
    );
  });
}
