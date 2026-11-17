'use strict';
/**
 * Safe file uploads: multer keeps the file in memory, we verify its real type by magic
 * bytes (the client-supplied name/MIME is never trusted), hash it, then write it under a
 * random name. Files are only ever served through authenticated routes.
 * Swap `saveFile` / `resolveStored` for S3 (putObject / signed URL) in deployment.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { badRequest } = require('./errors');

const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

const SIGNATURES = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** @returns {{ext:string, mime:string}|null} */
function sniff(buffer, allowed) {
  const hit = SIGNATURES.find((s) => allowed.includes(s.ext) && s.test(buffer));
  return hit ? { ext: hit.ext, mime: hit.mime } : null;
}

/** Express middleware: parse ONE multipart file field called `file`. */
const singleFile = (maxBytes) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 20 } }).single('file');

/** Validate type + hash an uploaded file. Throws a 400 if the content isn't an allowed type. */
function inspectUpload(file, allowed, label = 'file') {
  if (!file) throw badRequest('FILE_REQUIRED', `A ${label} is required (multipart field "file")`);
  const type = sniff(file.buffer, allowed);
  if (!type) throw badRequest('INVALID_FILE_TYPE', `Only ${allowed.map((e) => e.toUpperCase()).join(', ')} files are accepted`);
  return { ...type, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), size: file.size };
}

/** Write to uploads/<ownerId>/<random>.<ext>; returns the relative path stored in the DB. */
async function saveFile(ownerId, buffer, ext) {
  const rel = path.posix.join(ownerId, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
  const abs = path.join(UPLOAD_ROOT, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, buffer, { flag: 'wx' });
  return rel;
}

/** Map a stored relative path to an absolute one, refusing anything outside UPLOAD_ROOT. */
function resolveStored(rel) {
  const abs = path.resolve(UPLOAD_ROOT, rel);
  if (!abs.startsWith(UPLOAD_ROOT + path.sep)) throw badRequest('INVALID_PATH', 'Invalid file path');
  return abs;
}

const removeFile = (rel) => fs.promises.rm(resolveStored(rel), { force: true }).catch(() => {});

module.exports = { UPLOAD_ROOT, singleFile, inspectUpload, saveFile, resolveStored, removeFile, sniff };
