/**
 * HTML rendering helpers for the admin dashboard.
 *
 * Extracts view-building logic from app.js to keep route handlers clean.
 * All functions return HTML strings for template injection.
 */

import { escapeHtml } from './utils.js';

// ─── Date / Badge formatters ────────────────────────────────────────

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function refundBadge(status) {
  const map = {
    none: '',
    pending_approval: '<span class="status-badge badge-pending">Pending</span>',
    approved: '<span class="status-badge badge-approved">Approved</span>',
    denied: '<span class="status-badge badge-denied">Denied</span>',
    auto_refunded: '<span class="status-badge badge-auto">Automatic</span>',
    error: '<span class="status-badge badge-denied">Error</span>',
  };
  return status in map ? map[status] : escapeHtml(String(status));
}

// ─── Status checkboxes ──────────────────────────────────────────────

export function buildStatusCheckboxes(allStatuses, allowed, groupName) {
  return allStatuses
    .map((s) => {
      const checked = allowed.includes(s.value) ? 'checked' : '';
      return `<label class="cb-label">
      <input type="checkbox" value="${s.value}" data-group="${groupName}" ${checked} />
      <span class="cb-text">${escapeHtml(s.label)}</span>
      <code class="cb-code">${s.value}</code>
    </label>`;
    })
    .join('\n');
}

// ─── Pagination ─────────────────────────────────────────────────────

export function buildPagination(tableType, result) {
  const { page, totalPages } = result;

  if (totalPages <= 1) {
    return '';
  }

  const prevDisabled = page === 1 ? 'disabled' : '';
  const nextDisabled = page === totalPages ? 'disabled' : '';

  // tableType is hardcoded at build time (either 'pending' or 'recent') and safe from injection
  return `
    <div class="pagination">
      <button class="pagination-btn" onclick="goToPage(${Math.max(1, page - 1)}, '${tableType}')" ${prevDisabled}>
        Previous
      </button>
      <span class="pagination-info">Page ${page} of ${totalPages}</span>
      <button class="pagination-btn" onclick="goToPage(${Math.min(totalPages, page + 1)}, '${tableType}')" ${nextDisabled}>
        Next
      </button>
    </div>
  `;
}

// ─── Tables ─────────────────────────────────────────────────────────

export function buildPendingTable(pending) {
  if (pending.length === 0) {
    return '<p class="empty">No pending refunds awaiting approval.</p>';
  }
  const rows = pending
    .map(
      (r) => `
    <tr>
      <td><strong>${escapeHtml(r.orderNumber)}</strong></td>
      <td>${escapeHtml(r.email)}</td>
      <td>${formatDate(r.cancelledAt)}</td>
      <td>
        <button class="btn btn-approve" data-action="approve" data-id="${escapeHtml(r.id)}">Approve</button>
        <button class="btn btn-deny" data-action="deny" data-id="${escapeHtml(r.id)}">Deny</button>
      </td>
    </tr>
  `,
    )
    .join('');

  return `<table>
    <thead><tr><th>Order</th><th>Email</th><th>Cancelled</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function buildRecentTable(recent) {
  if (recent.length === 0) {
    return '<p class="empty">No recent cancellations.</p>';
  }
  const rows = recent
    .map(
      (r) => `
    <tr>
      <td><strong>${escapeHtml(r.orderNumber)}</strong></td>
      <td>${escapeHtml(r.email)}</td>
      <td>${formatDate(r.cancelledAt)}</td>
      <td>${refundBadge(r.refundStatus)}</td>
    </tr>
  `,
    )
    .join('');

  return `<table>
    <thead><tr><th>Order</th><th>Email</th><th>Cancelled</th><th>Refund</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
