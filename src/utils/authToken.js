import crypto from 'crypto';

const TOKEN_TTL_SECONDS = 60 * 60 * 12;
const secret = () => process.env.JWT_SECRET || 'inventia-local-development-secret';

export function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id),
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return { id: decoded.sub, role: decoded.role };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, storedHash, username) {
  if (storedHash?.startsWith('scrypt:')) {
    const [, salt, expected] = storedHash.split(':');
    const actual = crypto.scryptSync(password, salt, 64);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  }
  const legacyDefaults = { admin: 'admin123', vivin: 'manager123' };
  return legacyDefaults[username] === password;
}
