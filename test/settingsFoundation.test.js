import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-settings-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'settings-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'settings-test-master-key';
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const settings = await import('../src/domains/settings/settingsService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({
  hashPassword: authModule.hashPlatformPassword
});
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: crypto.randomUUID(),
  user: {
    id: session.user.id,
    tenant_user_id: session.user.id,
    role: session.user.role,
    permissions: session.user.permissions,
    organization_id: session.organization.id
  },
  headers: {},
  ip: '127.0.0.1',
  tenantDb: db
};

test('Phase 6 settings migration seeds safe feature flags and namespace defaults', async () => {
  const migration = await db.one(
    'SELECT version FROM migration_versions WHERE version = ?',
    ['phase6-settings-foundation-001']
  );
  assert.equal(migration.version, 'phase6-settings-foundation-001');

  const flags = await settings.listFeatureFlags(db);
  assert.equal(flags.frontend_modules.enabled, true);
  assert.equal(flags.settings_namespaces.enabled, true);
  assert.equal(flags.navigation_v2.enabled, false);

  const documents = await settings.getSettingsNamespace(db, 'documents');
  assert.equal(documents.settings.orientation, 'portrait');
  assert.equal(documents.settings.margins.top, 10);
  assert.equal(documents.updated_at, null);
});

test('settings updates merge nested values and create immutable audit evidence', async () => {
  const result = await settings.updateSettingsNamespace(db, 'documents', {
    repeat_header: false,
    margins: { left: 24 }
  }, request);
  assert.equal(result.settings.repeat_header, false);
  assert.equal(result.settings.margins.left, 24);
  assert.equal(result.settings.margins.right, 10);

  const stored = await settings.getSettingsNamespace(db, 'documents');
  assert.equal(stored.settings.margins.left, 24);
  assert.equal(stored.updated_by, session.user.id);

  const audit = await db.one(
    `SELECT event_type, entity_id
       FROM audit_logs
      WHERE event_type = 'settings.namespace.updated'
      ORDER BY id DESC LIMIT 1`
  );
  assert.equal(audit.entity_id, 'documents');
});

test('feature flags are allow-listed, audited, and tenant isolated', async () => {
  const changed = await settings.updateFeatureFlag(db, 'navigation_v2', {
    enabled: true,
    configuration: { rollout: 'test' }
  }, request);
  assert.equal(changed.enabled, true);
  assert.equal(changed.configuration.rollout, 'test');

  await assert.rejects(
    () => settings.updateFeatureFlag(db, 'unknown_flag', { enabled: true }, request),
    error => error.code === 'feature_flag_not_found'
  );
  await assert.rejects(
    () => settings.getSettingsNamespace(db, 'secrets'),
    error => error.code === 'settings_namespace_not_found'
  );

  const control = databaseModule.getControlDatabase();
  const organizationId = '00000000-0000-4000-8000-000000000077';
  await control.run(
    `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
     VALUES (?, 'settings-isolated', 'Settings Isolated', 'active', ?, ?)`,
    [organizationId, new Date().toISOString(), new Date().toISOString()]
  );
  const isolated = await databaseModule.provisionOrganizationDatabase({
    organizationId,
    slug: 'settings-isolated'
  });
  const isolatedFlags = await settings.listFeatureFlags(isolated);
  assert.equal(isolatedFlags.navigation_v2.enabled, false);
});
