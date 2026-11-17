'use strict';
/**
 * Minimal RFC 4180 CSV reader/writer (no dependency).
 *  - parse():  quoted fields, "" escapes, CRLF/LF, BOM, embedded newlines. Header names are
 *              lower-cased and trimmed with spaces/dashes turned into underscores.
 *  - toCsv():  quotes when needed and neutralises spreadsheet formula injection: a cell that
 *              starts with = + - @ (or tab/CR) is prefixed with an apostrophe so Excel
 *              shows it as text instead of executing it.
 */

/** @returns {Array<{cells: string[], line: number}>} raw rows with the 1-based physical line each one starts on. */
function readRows(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = []; let cell = ''; let quoted = false; let i = 0; let touched = false;
  let line = 1; let rowLine = 1;
  const endRow = () => {
    if (touched || cell !== '') { row.push(cell); rows.push({ cells: row, line: rowLine }); }
    row = []; cell = ''; touched = false;
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      if (ch === '\n') line += 1;
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; touched = true; i += 1; continue; }
    if (ch === ',') { row.push(cell); cell = ''; touched = true; i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      i += 1; endRow(); line += 1; rowLine = line; continue;
    }
    cell += ch; touched = true; i += 1;
  }
  if (quoted) throw new Error('Unterminated quote in CSV');
  endRow();
  return rows;
}

/** @returns {string[][]} raw cells only. Throws on an unterminated quote. */
const parseRows = (text) => readRows(text).map((r) => r.cells);

const normHeader = (h) => String(h).trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * @returns {{ headers: string[], records: Array<{ line: number, values: Record<string,string> }> }}
 * `line` is the 1-based line in the file (header = 1) so error reports point at the right row.
 */
function parse(text) {
  const rows = readRows(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].cells.map(normHeader);
  const records = [];
  for (const { cells, line } of rows.slice(1)) {
    if (cells.every((c) => c.trim() === '')) continue;               // a row of only commas
    const values = {};
    headers.forEach((h, c) => { values[h] = (cells[c] ?? '').trim(); });
    records.push({ line, values });
  }
  return { headers, records };
}

const cell = (v) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param headers string[]  @param rows any[][] */
const toCsv = (headers, rows) => [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

module.exports = { parse, parseRows, toCsv };
