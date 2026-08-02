export class ApiError extends Error {
  constructor(message, { status = 500, code = 'request_failed', details = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function apiErrorFromResponse(response, payload) {
  const error = payload?.error;
  if (error && typeof error === 'object') {
    return new ApiError(error.message || response.statusText || 'Request failed.', {
      status: response.status,
      code: error.code || 'request_failed',
      details: error.details || null,
      requestId: error.request_id || response.headers.get('x-request-id')
    });
  }
  return new ApiError(payload?.message || response.statusText || 'Request failed.', {
    status: response.status,
    code: payload?.code || 'request_failed',
    details: payload?.details || null,
    requestId: response.headers.get('x-request-id')
  });
}

export function normalizeError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(error?.message || 'An unexpected error occurred.', {
    code: error?.code || 'unexpected_error'
  });
}
