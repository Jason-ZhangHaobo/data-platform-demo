#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MetadataStore } from '../src/v2/store.mjs';
import { BusinessQueryStore } from '../src/v2/data-services.mjs';
import { ReportDataStore } from '../src/v2/reports.mjs';
import { verifySavedWealthLifecycle } from '../src/v2/wealth-saved-lifecycle.mjs';

const required = ['metadata', 'business-snapshots', 'report-snapshots', 'release-id', 'package-digest',
  'batch-id', 'report-id', 'run-id'];
const stores = [];
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(required.map(key => [key, { type: 'string' }])),
    'dapi-call-id': { type: 'string', multiple: true, default: [] },
    'xapi-call-id': { type: 'string', multiple: true, default: [] },
    project: { type: 'string', default: 'project-securities-lab' },
    actor: { type: 'string', default: 'local-engineer' },
  } });
  const dapiCallIds = values['dapi-call-id'], xapiCallIds = values['xapi-call-id'];
  if ([...required, 'project', 'actor'].some(key => !values[key]?.trim()) || !dapiCallIds.length || !xapiCallIds.length)
    throw Object.assign(Error('WEALTH_SAVED_ARGUMENTS_REQUIRED'), { code: 'WEALTH_SAVED_ARGUMENTS_REQUIRED' });
  const open = (Store, key) => {
    const db = new Store(values[key], { readOnly: true });
    stores.push(db);
    db.db.exec('BEGIN');
    return db;
  };
  const result = verifySavedWealthLifecycle({ store: open(MetadataStore, 'metadata'),
    businessStore: open(BusinessQueryStore, 'business-snapshots'), reportStore: open(ReportDataStore, 'report-snapshots'),
    project: values.project, actor: values.actor, releaseId: values['release-id'], packageDigest: values['package-digest'],
    batchId: values['batch-id'], reportId: values['report-id'], runId: values['run-id'], dapiCallIds, xapiCallIds });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code : 'WEALTH_SAVED_VERIFICATION_FAILED';
  process.stderr.write(JSON.stringify({ status: 'FAILED', code }) + '\n');
  process.exitCode = 1;
} finally {
  for (const store of stores.reverse()) {
    if (store.db.isTransaction) store.db.exec('ROLLBACK');
    store.close();
  }
}
