import { EventEmitter } from 'events';
import { createClient } from 'redis';
import { Queue } from 'bullmq';
import { Server as SocketServer } from 'socket.io';
import { jwtVerify } from 'jose';

const localEvents = new EventEmitter();
const memoryCache = new Map();
let redisClient;
let jobsQueue;
let socketServer;

export async function initializePhase5Runtime(httpServer) {
  if (process.env.REDIS_URL && !redisClient) {
    try {
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', error => console.warn('Redis unavailable:', error.message));
      await redisClient.connect();
      jobsQueue = new Queue('inventia-domain-jobs', { connection: redisOptions(process.env.REDIS_URL) });
    } catch (error) {
      console.warn('Using local cache/events because Redis is unavailable:', error.message);
      redisClient = null;
      jobsQueue = null;
    }
  }
  if (httpServer && !socketServer) {
    socketServer = new SocketServer(httpServer, {
      path: '/realtime',
      cors: { origin: process.env.CORS_ORIGIN || '*' }
    });
    socketServer.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) throw new Error('authentication_required');
        const { payload } = await jwtVerify(token, jwtKey(), {
          issuer: 'inventia',
          audience: 'inventia-api'
        });
        if (!payload.organization_id || !payload.sub) throw new Error('invalid_access_token');
        socket.data.organizationId = payload.organization_id;
        socket.data.userId = payload.sub;
        next();
      } catch {
        next(new Error('authentication_failed'));
      }
    });
    socketServer.on('connection', socket => {
      socket.join(`organization:${socket.data.organizationId}`);
    });
  }
  return { redis: Boolean(redisClient), jobs: Boolean(jobsQueue), realtime: Boolean(socketServer) };
}

export async function cacheGet(organizationId, key) {
  const namespaced = cacheKey(organizationId, key);
  if (redisClient?.isReady) {
    const value = await redisClient.get(namespaced);
    return value ? JSON.parse(value) : null;
  }
  const entry = memoryCache.get(namespaced);
  if (!entry || entry.expiresAt <= Date.now()) {
    memoryCache.delete(namespaced);
    return null;
  }
  return entry.value;
}

export async function cacheSet(organizationId, key, value, ttlSeconds = 60) {
  const namespaced = cacheKey(organizationId, key);
  if (redisClient?.isReady) {
    await redisClient.set(namespaced, JSON.stringify(value), { EX: ttlSeconds });
  } else {
    memoryCache.set(namespaced, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  return value;
}

export async function invalidateOrganizationCache(organizationId) {
  const prefix = cacheKey(organizationId, '');
  if (redisClient?.isReady) {
    for await (const key of redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      await redisClient.del(key);
    }
  } else {
    for (const key of memoryCache.keys()) if (key.startsWith(prefix)) memoryCache.delete(key);
  }
}

export async function publishOrganizationEvent(organizationId, event, payload) {
  const envelope = { event, organization_id: organizationId, payload, occurred_at: new Date().toISOString() };
  socketServer?.to(`organization:${organizationId}`).emit(event, envelope);
  localEvents.emit(`organization:${organizationId}`, envelope);
  if (redisClient?.isReady) await redisClient.publish(`inventia:organization:${organizationId}`, JSON.stringify(envelope));
  return envelope;
}

export async function enqueueDomainJob(name, data, options = {}) {
  if (!jobsQueue) return { queued: false, provider: 'inline' };
  const job = await jobsQueue.add(name, data, {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    ...options
  });
  return { queued: true, provider: 'bullmq', job_id: job.id };
}

export function runtimeState() {
  return {
    cache: redisClient?.isReady ? 'redis' : 'memory',
    jobs: jobsQueue ? 'bullmq' : 'inline',
    realtime: socketServer ? 'socket.io' : 'disabled'
  };
}

function cacheKey(organizationId, key) {
  return `inventia:${organizationId}:${key}`;
}

function jwtKey() {
  return new TextEncoder().encode(process.env.JWT_SECRET || 'inventia-local-development-secret');
}

export function redisOptions(connectionUrl = process.env.REDIS_URL) {
  const parsed = new URL(connectionUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  };
}
