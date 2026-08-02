import { apiErrorFromResponse } from './errors.js';
import { createIdempotencyKey, isMutationMethod } from './idempotency.js';

export class InventiaApiClient {
  constructor({
    baseUrl = '/api/v1',
    storage = globalThis.localStorage,
    fetchImpl = (...args) => globalThis.fetch(...args)
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.storage = storage;
    this.fetchImpl = fetchImpl;
  }

  async request(path, {
    method = 'GET',
    body,
    headers = {},
    signal,
    idempotencyKey,
    responseType = 'json'
  } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    const requestHeaders = new Headers(headers);
    const token = this.storage?.getItem('phase5AccessToken');
    if (token && !requestHeaders.has('Authorization')) {
      requestHeaders.set('Authorization', `Bearer ${token}`);
    }
    if (body != null && !(body instanceof FormData) && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json');
    }
    if (isMutationMethod(normalizedMethod) && !requestHeaders.has('Idempotency-Key')) {
      requestHeaders.set('Idempotency-Key', idempotencyKey || createIdempotencyKey());
    }

    const response = await this.fetchImpl(this.resolveUrl(path), {
      method: normalizedMethod,
      headers: requestHeaders,
      body: body == null || body instanceof FormData ? body : JSON.stringify(body),
      signal
    });
    if (response.status === 204) return null;

    const payload = responseType === 'blob'
      ? await response.blob()
      : await readJsonResponse(response);
    if (!response.ok) throw apiErrorFromResponse(response, payload);
    return payload;
  }

  get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, body, options) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  patch(path, body, options) {
    return this.request(path, { ...options, method: 'PATCH', body });
  }

  delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }

  resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}/${String(path || '').replace(/^\//, '')}`;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
