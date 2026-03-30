import { describe, it, expect } from 'vitest';
import {
  formatDate,
  refundBadge,
  buildStatusCheckboxes,
  buildPagination,
  buildPendingTable,
  buildRecentTable,
} from '../src/views.js';

describe('views.js — formatDate', () => {
  it('returns dash for null/undefined', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('formats a valid ISO date', () => {
    const result = formatDate('2026-03-15T14:30:00Z');
    expect(result).toMatch(/03\/15\/2026/);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('views.js — refundBadge', () => {
  it('returns empty string for "none"', () => {
    expect(refundBadge('none')).toBe('');
  });

  it('returns badge HTML for known statuses', () => {
    expect(refundBadge('pending_approval')).toContain('badge-pending');
    expect(refundBadge('approved')).toContain('badge-approved');
    expect(refundBadge('denied')).toContain('badge-denied');
    expect(refundBadge('auto_refunded')).toContain('badge-auto');
    expect(refundBadge('error')).toContain('badge-denied');
  });

  it('escapes unknown status values', () => {
    const result = refundBadge('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('views.js — buildStatusCheckboxes', () => {
  const statuses = [
    { value: 'UNFULFILLED', label: 'Unfulfilled' },
    { value: 'FULFILLED', label: 'Fulfilled' },
  ];

  it('renders checkboxes with correct values', () => {
    const html = buildStatusCheckboxes(statuses, ['UNFULFILLED'], 'fulfillment');
    expect(html).toContain('value="UNFULFILLED"');
    expect(html).toContain('value="FULFILLED"');
    expect(html).toContain('data-group="fulfillment"');
  });

  it('marks allowed statuses as checked', () => {
    const html = buildStatusCheckboxes(statuses, ['UNFULFILLED'], 'fulfillment');
    // UNFULFILLED should be checked
    expect(html).toMatch(/value="UNFULFILLED".*checked/s);
    // FULFILLED should NOT be checked (no checked attribute near its value)
    const fulfilledLine = html.split('\n').find((l) => l.includes('FULFILLED') && !l.includes('UNFULFILLED'));
    expect(fulfilledLine).not.toContain('checked');
  });

  it('escapes label text', () => {
    const xssStatuses = [{ value: 'TEST', label: '<img onerror=alert(1)>' }];
    const html = buildStatusCheckboxes(xssStatuses, [], 'test');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img');
  });
});

describe('views.js — buildPagination', () => {
  it('returns empty string for single page', () => {
    expect(buildPagination('pending', { page: 1, totalPages: 1 })).toBe('');
  });

  it('renders pagination with correct page info', () => {
    const html = buildPagination('pending', { page: 2, totalPages: 5 });
    expect(html).toContain('Page 2 of 5');
    expect(html).toContain('goToPage(1');
    expect(html).toContain('goToPage(3');
  });

  it('disables Previous on first page', () => {
    const html = buildPagination('recent', { page: 1, totalPages: 3 });
    expect(html).toMatch(/goToPage\(1.*disabled/s);
  });

  it('disables Next on last page', () => {
    const html = buildPagination('recent', { page: 3, totalPages: 3 });
    expect(html).toMatch(/goToPage\(3.*disabled/s);
  });
});

describe('views.js — buildPendingTable', () => {
  it('shows empty message when no pending items', () => {
    const html = buildPendingTable([]);
    expect(html).toContain('No pending refunds');
  });

  it('renders table rows with escaped data', () => {
    const pending = [
      {
        id: 'abc-123',
        orderNumber: '#1001',
        email: 'test@example.com',
        cancelledAt: '2026-03-15T10:00:00Z',
      },
    ];
    const html = buildPendingTable(pending);
    expect(html).toContain('<table>');
    expect(html).toContain('#1001');
    expect(html).toContain('test@example.com');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
    expect(html).toContain('data-id="abc-123"');
  });

  it('escapes XSS in order number', () => {
    const pending = [
      {
        id: '1',
        orderNumber: '<script>alert(1)</script>',
        email: 'x@x.com',
        cancelledAt: null,
      },
    ];
    const html = buildPendingTable(pending);
    expect(html).not.toContain('<script>alert');
  });
});

describe('views.js — buildRecentTable', () => {
  it('shows empty message when no recent items', () => {
    const html = buildRecentTable([]);
    expect(html).toContain('No recent cancellations');
  });

  it('renders refund status badges', () => {
    const recent = [
      {
        orderNumber: '#2002',
        email: 'user@shop.com',
        cancelledAt: '2026-03-15T10:00:00Z',
        refundStatus: 'approved',
      },
    ];
    const html = buildRecentTable(recent);
    expect(html).toContain('badge-approved');
  });
});
