import crypto from 'crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { jwtVerify, SignJWT } from 'jose';
import {
  getControlDatabase,
  getTenantDatabase,
  initializePhase5Platform,
  rolePermissions,
  DEFAULT_ORGANIZATION_SLUG
} from './phase5Database.js';

const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 900);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);

export async function hashPlatformPassword(password) {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32
  });
}

export async function verifyPlatformPassword(password, encoded) {
  if (!encoded) return false;
  if (encoded.startsWith('$argon2')) return verify(encoded, password);
  if (encoded.startsWith('scrypt:')) {
    const [, salt, expected] = encoded.split(':');
    const actual = crypto.scryptSync(password, salt, 64);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  }
  return false;
}

export async function loginPlatform({ organizationSlug, username, password, userAgent, ipAddress }) {
  await initializePhase5Platform({ hashPassword: hashPlatformPassword });
  const control = getControlDatabase();
  const slug = organizationSlug || DEFAULT_ORGANIZATION_SLUG;
  const account = await control.one(
    `SELECT u.id AS user_id, u.username, u.email, u.password_hash, u.full_name,
            u.status AS user_status, o.id AS organization_id, o.slug AS organization_slug,
            o.name AS organization_name, o.status AS organization_status,
            m.role, m.permissions, m.status AS membership_status
       FROM platform_users u
       JOIN memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
      WHERE lower(u.username) = lower(?) AND o.slug = ?`,
    [username, slug]
  );
  if (!account || account.user_status !== 'active' || account.organization_status !== 'active' || account.membership_status !== 'active') {
    throw authError(401, 'invalid_credentials', 'Invalid organization, username, or password.');
  }
  if (!await verifyPlatformPassword(password, account.password_hash)) {
    throw authError(401, 'invalid_credentials', 'Invalid organization, username, or password.');
  }
  const session = await issueSession(account, { userAgent, ipAddress });
  await control.run('UPDATE platform_users SET last_login_at = ?, updated_at = ? WHERE id = ?', [now(), now(), account.user_id]);
  await writeControlAudit({
    organizationId: account.organization_id,
    userId: account.user_id,
    eventType: 'auth.login',
    ipAddress,
    metadata: { session_id: session.session_id }
  });
  return { ...session, user: publicUser(account), organization: publicOrganization(account) };
}

export async function refreshPlatformSession(refreshToken, { userAgent, ipAddress } = {}) {
  await initializePhase5Platform({ hashPassword: hashPlatformPassword });
  const [sessionId, secret] = String(refreshToken || '').split('.');
  if (!sessionId || !secret) throw authError(401, 'invalid_refresh_token', 'Refresh token is invalid.');
  const control = getControlDatabase();
  const session = await control.one(
    `SELECT s.*, u.username, u.email, u.full_name, u.status AS user_status,
            o.slug AS organization_slug, o.name AS organization_name, o.status AS organization_status,
            m.role, m.permissions, m.status AS membership_status
       FROM sessions s
       JOIN platform_users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.organization_id
       JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
      WHERE s.id = ?`,
    [sessionId]
  );
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    throw authError(401, 'refresh_token_expired', 'Refresh session is expired or revoked.');
  }
  if (!safeEqual(session.refresh_token_hash, hashRefreshSecret(secret))) {
    await control.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), sessionId]);
    throw authError(401, 'refresh_token_reused', 'Refresh token reuse was detected; the session has been revoked.');
  }
  if (session.user_status !== 'active' || session.organization_status !== 'active' || session.membership_status !== 'active') {
    throw authError(403, 'membership_inactive', 'This organization membership is inactive.');
  }
  await control.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), sessionId]);
  const account = {
    user_id: session.user_id,
    username: session.username,
    email: session.email,
    full_name: session.full_name,
    organization_id: session.organization_id,
    organization_slug: session.organization_slug,
    organization_name: session.organization_name,
    role: session.role,
    permissions: session.permissions
  };
  const rotated = await issueSession(account, { userAgent, ipAddress, rotatedFrom: sessionId });
  return { ...rotated, user: publicUser(account), organization: publicOrganization(account) };
}

export async function logoutPlatformSession(refreshToken, actor = {}) {
  const [sessionId] = String(refreshToken || '').split('.');
  if (!sessionId) return;
  const control = getControlDatabase();
  await control.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now(), sessionId]);
  if (actor.organizationId) {
    await writeControlAudit({
      organizationId: actor.organizationId,
      userId: actor.userId,
      eventType: 'auth.logout',
      metadata: { session_id: sessionId }
    });
  }
}

export async function switchPlatformOrganization(userId, organizationId, request = {}) {
  const control = getControlDatabase();
  const membership = await control.one(
    `SELECT u.id AS user_id, u.username, u.email, u.full_name,
            o.id AS organization_id, o.slug AS organization_slug, o.name AS organization_name,
            m.role, m.permissions
       FROM platform_users u
       JOIN memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
      WHERE u.id = ? AND o.id = ? AND u.status = 'active' AND o.status = 'active' AND m.status = 'active'`,
    [userId, organizationId]
  );
  if (!membership) throw authError(403, 'organization_access_denied', 'You do not have access to this organization.');
  const issued = await issueSession(membership, request);
  return { ...issued, user: publicUser(membership), organization: publicOrganization(membership) };
}

export async function listPlatformOrganizations(userId) {
  const control = getControlDatabase();
  return control.all(
    `SELECT o.id, o.slug, o.name, o.status, m.role, m.permissions
       FROM organizations o JOIN memberships m ON m.organization_id = o.id
      WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active'
      ORDER BY o.name`,
    [userId]
  ).then(rows => rows.map(row => ({ ...row, permissions: parseJson(row.permissions, rolePermissions(row.role)) })));
}

export async function authenticateV1(req, res, next) {
  try {
    await initializePhase5Platform({ hashPassword: hashPlatformPassword });
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token) throw authError(401, 'authentication_required', 'A valid access token is required.');
    const { payload } = await jwtVerify(token, jwtKey(), {
      issuer: 'inventia',
      audience: 'inventia-api'
    });
    if (!payload.sub || !payload.organization_id || !payload.session_id) {
      throw authError(401, 'invalid_access_token', 'Access token is missing required claims.');
    }
    const control = getControlDatabase();
    const session = await control.one(
      `SELECT s.id, s.revoked_at, s.expires_at, u.username
       FROM sessions s JOIN platform_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.user_id = ? AND s.organization_id = ?`,
      [payload.session_id, payload.sub, payload.organization_id]
    );
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      throw authError(401, 'session_expired', 'The access session has expired or was revoked.');
    }
    req.user = {
      id: payload.sub,
      role: payload.role,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
      organization_id: payload.organization_id,
      organization_slug: payload.organization_slug,
      session_id: payload.session_id
    };
    req.tenantDb = await getTenantDatabase(req.user.organization_id);
    try {
      const tenantUser = await req.tenantDb.one('SELECT id FROM users WHERE lower(username) = lower(?)', [session.username]);
      req.user.tenant_user_id = tenantUser?.id || req.user.id;
    } catch {
      req.user.tenant_user_id = req.user.id;
    }
    next();
  } catch (error) {
    if (String(error?.code || '').startsWith('ERR_JWT_')) {
      return next(authError(
        401,
        error.code === 'ERR_JWT_EXPIRED' ? 'access_token_expired' : 'invalid_access_token',
        error.code === 'ERR_JWT_EXPIRED' ? 'The access token has expired.' : 'The access token is invalid.'
      ));
    }
    next(error);
  }
}

export function requirePermission(permission) {
  return (req, _res, next) => {
    if (hasPermission(req.user?.permissions || [], permission)) return next();
    next(authError(403, 'permission_denied', `Permission '${permission}' is required.`));
  };
}

export function hasPermission(grants, requested) {
  if (grants.includes('*') || grants.includes(requested)) return true;
  return grants.some(grant => {
    if (!grant.endsWith('.*')) return false;
    return requested.startsWith(grant.slice(0, -1));
  });
}

async function issueSession(account, { userAgent, ipAddress, rotatedFrom } = {}) {
  const control = getControlDatabase();
  const sessionId = crypto.randomUUID();
  const refreshSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000).toISOString();
  const permissions = parseJson(account.permissions, rolePermissions(account.role));
  await control.run(
    `INSERT INTO sessions
      (id, organization_id, user_id, refresh_token_hash, user_agent, ip_address,
       expires_at, revoked_at, rotated_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      sessionId,
      account.organization_id,
      account.user_id,
      hashRefreshSecret(refreshSecret),
      String(userAgent || '').slice(0, 500),
      String(ipAddress || '').slice(0, 100),
      expiresAt,
      rotatedFrom || null,
      now()
    ]
  );
  const accessToken = await new SignJWT({
    role: account.role,
    permissions,
    organization_id: account.organization_id,
    organization_slug: account.organization_slug,
    session_id: sessionId
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(account.user_id)
    .setIssuer('inventia')
    .setAudience('inventia-api')
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .setJti(crypto.randomUUID())
    .sign(jwtKey());
  return {
    access_token: accessToken,
    refresh_token: `${sessionId}.${refreshSecret}`,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    session_id: sessionId
  };
}

export async function writeControlAudit({ organizationId, userId, eventType, requestId, ipAddress, metadata }) {
  const control = getControlDatabase();
  await control.run(
    `INSERT INTO control_audit_logs
      (id, organization_id, actor_user_id, event_type, request_id, ip_address, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      organizationId || null,
      userId || null,
      eventType,
      requestId || null,
      ipAddress || null,
      JSON.stringify(metadata || {}),
      now()
    ]
  );
}

function jwtKey() {
  const secret = process.env.JWT_SECRET || 'inventia-local-development-secret';
  if (process.env.NODE_ENV === 'production' && secret === 'inventia-local-development-secret') {
    throw new Error('JWT_SECRET is required in production.');
  }
  return new TextEncoder().encode(secret);
}

function hashRefreshSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(account) {
  return {
    id: account.user_id,
    username: account.username,
    email: account.email,
    full_name: account.full_name,
    role: account.role,
    permissions: parseJson(account.permissions, rolePermissions(account.role))
  };
}

function publicOrganization(account) {
  return {
    id: account.organization_id,
    slug: account.organization_slug,
    name: account.organization_name
  };
}

function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function authError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function now() {
  return new Date().toISOString();
}
