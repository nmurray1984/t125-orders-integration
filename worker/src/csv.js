/**
 * CSV rendering for roster exports.
 *
 * These files get opened in Excel and Google Sheets, so a cell beginning with
 * =, +, -, or @ would be evaluated as a formula. Prefixing with a single quote
 * neutralizes that without changing what a reader sees.
 */

function escapeCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map((h) => escapeCell(h.label)).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h.key])).join(','));
  }
  // Excel needs the BOM to read UTF-8 names correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export const ROSTER_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'rank', label: 'Rank' },
  { key: 'patrol', label: 'Patrol' },
  { key: 'cell_phone', label: 'Cell Phone' },
  { key: 'emergency_contact', label: 'Emergency Contact' },
  { key: 'emergency_contact_phone', label: 'Emergency Contact Phone' },
  { key: 'travel_to_campout', label: 'Travel to Campout' },
  { key: 'campout', label: 'Campout' },
  { key: 'variation_name', label: 'Registration Type' },
  { key: 'total_money', label: 'Total Paid' },
  { key: 'order_created_at', label: 'Ordered At' },
  { key: 'order_id', label: 'Order ID' },
];
