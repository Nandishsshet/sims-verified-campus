'use strict';
/**
 * Unique key generation for the University → College → Class chain.
 *
 * Format  PFX-XXXX-XXXX   e.g. CLS-8F3K-92QA
 *   PFX     UNI | COL | CLS
 *   X       32-symbol alphabet with no 0/1/I/O (hard to misread when shared verbally)
 * 8 symbols × 5 bits = 40 bits of entropy, drawn from crypto.randomInt (CSPRNG,
 * unbiased). The DB has a CHECK constraint with the same pattern.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols
const PREFIXES = Object.freeze({ university: 'UNI', college: 'COL', class: 'CLS' });
const KEY_REGEX = /^(UNI|COL|CLS)-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

function randomGroup(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** @param {'UNI'|'COL'|'CLS'} prefix */
function generateKey(prefix) {
  if (!Object.values(PREFIXES).includes(prefix)) throw new Error(`Unknown key prefix: ${prefix}`);
  return `${prefix}-${randomGroup()}-${randomGroup()}`;
}

/**
 * Tolerant parsing of what a human typed: trims, upper-cases, strips spaces and
 * accepts the key without hyphens. Returns the canonical key, or null if malformed.
 */
function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{3}[A-Z0-9]{8}$/.test(v)) v = `${v.slice(0, 3)}-${v.slice(3, 7)}-${v.slice(7)}`;
  return KEY_REGEX.test(v) ? v : null;
}

/**
 * Public certificate verification code, printed in the QR:  CRT-XXXXX-XXXXX (50 bits).
 * Same alphabet as join keys; unrelated to them (certificates are looked up read-only).
 */
const generateVerificationCode = () => `CRT-${randomGroup(5)}-${randomGroup(5)}`;
const CERT_CODE_REGEX = /^CRT-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;

module.exports = { ALPHABET, PREFIXES, KEY_REGEX, CERT_CODE_REGEX, generateKey, normalizeKey, generateVerificationCode };
