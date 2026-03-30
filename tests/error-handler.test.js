import { describe, it, expect, vi } from 'vitest';
import { captureError, expressErrorHandler } from '../src/errorHandler.js';

describe('errorHandler — captureError', () => {
  it('logs the error without crashing when no Sentry configured', () => {
    // Should not throw even without SENTRY_DSN
    expect(() => {
      captureError(new Error('test error'), { orderId: '123', traceId: 'abc' });
    }).not.toThrow();
  });

  it('handles non-Error objects gracefully', () => {
    expect(() => {
      captureError(new Error('string error'), { context: 'test' });
    }).not.toThrow();
  });
});

describe('errorHandler — expressErrorHandler', () => {
  it('returns 500 and generic message', () => {
    const err = new Error('something broke');
    const req = {
      method: 'GET',
      originalUrl: '/test',
      ip: '127.0.0.1',
      traceId: 'trace-123',
    };
    const res = {
      headersSent: false,
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };
    const next = vi.fn();

    expressErrorHandler(err, req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('unexpected error');
  });

  it('does not send response if headers already sent', () => {
    const err = new Error('too late');
    const req = { method: 'GET', originalUrl: '/', ip: '127.0.0.1' };
    const res = {
      headersSent: true,
      status: vi.fn(),
      send: vi.fn(),
    };
    const next = vi.fn();

    expressErrorHandler(err, req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
