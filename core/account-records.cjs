const { randomUUID } = require('node:crypto');

const MAX_REMARK_LENGTH = 40;
const MAX_ACCOUNT_ID_LENGTH = 128;
const MAX_ACCOUNT_LENGTH = 320;
const MAX_ACCOUNT_MASK_LENGTH = 512;
const MAX_ACCESS_TOKEN_LENGTH = 16384;
const MAX_USERNAME_LENGTH = 256;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value, maxLength, { allowEmpty = false } = {}) {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maxLength;
}

function normalizeRemark(value) {
  const trimmed = String(value ?? '').trim();
  return Array.from(trimmed).slice(0, MAX_REMARK_LENGTH).join('');
}

function maskAccount(value) {
  const account = String(value ?? '').trim();
  if (/^\d{7,}$/.test(account)) {
    return `${account.slice(0, 3)}****${account.slice(-4)}`;
  }

  const at = account.indexOf('@');
  if (at > 0 && at < account.length - 1) {
    const firstUserCharacter = Array.from(account.slice(0, at))[0];
    return `${firstUserCharacter}***${account.slice(at)}`;
  }

  const characters = Array.from(account);
  if (characters.length > 4) {
    return `${characters.slice(0, 2).join('')}***${characters.slice(-2).join('')}`;
  }
  return '***';
}

function accountLabel(record) {
  const remark = normalizeRemark(record?.remark);
  if (remark) return remark;
  const accountMasked = String(record?.accountMasked ?? '').trim();
  return accountMasked || maskAccount(record?.account);
}

function validateAccountRecord(value) {
  const expectedKeys = [
    'accountId',
    'account',
    'accountMasked',
    'remark',
    'accessToken',
    'username',
    'savedAt',
    'updatedAt',
  ];
  const valid = hasExactKeys(value, expectedKeys)
    && isBoundedString(value.accountId, MAX_ACCOUNT_ID_LENGTH)
    && ACCOUNT_ID_PATTERN.test(value.accountId)
    && isBoundedString(value.account, MAX_ACCOUNT_LENGTH)
    && value.account === value.account.trim()
    && isBoundedString(value.accountMasked, MAX_ACCOUNT_MASK_LENGTH)
    && value.accountMasked === maskAccount(value.account)
    && typeof value.remark === 'string'
    && value.remark === normalizeRemark(value.remark)
    && isBoundedString(value.accessToken, MAX_ACCESS_TOKEN_LENGTH)
    && value.accessToken.trim().length > 0
    && isBoundedString(value.username, MAX_USERNAME_LENGTH, { allowEmpty: true })
    && isTimestamp(value.savedAt)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.savedAt;

  if (!valid) throw new TypeError('Invalid account record');
  return { ...value };
}

function validatePublicAccount(value) {
  const expectedKeys = [
    'accountId',
    'accountMasked',
    'remark',
    'label',
    'savedAt',
    'updatedAt',
  ];
  const valid = hasExactKeys(value, expectedKeys)
    && isBoundedString(value.accountId, MAX_ACCOUNT_ID_LENGTH)
    && ACCOUNT_ID_PATTERN.test(value.accountId)
    && isBoundedString(value.accountMasked, MAX_ACCOUNT_MASK_LENGTH)
    && value.accountMasked.includes('***')
    && typeof value.remark === 'string'
    && value.remark === normalizeRemark(value.remark)
    && isBoundedString(value.label, MAX_ACCOUNT_MASK_LENGTH)
    && value.label === (value.remark || value.accountMasked)
    && isTimestamp(value.savedAt)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.savedAt;

  if (!valid) throw new TypeError('Invalid public account');
  return { ...value };
}

function readTimestamp(value) {
  const timestamp = value ?? Date.now();
  if (!isTimestamp(timestamp)) throw new TypeError('Invalid account timestamp');
  return timestamp;
}

function readAccountId(options) {
  if (Object.hasOwn(options, 'accountId')) return String(options.accountId ?? '').trim();
  const randomId = typeof options.randomId === 'function' ? options.randomId : randomUUID;
  return String(randomId()).trim();
}

function createAccountRecord(input, options = {}) {
  if (!isPlainObject(input) || !isPlainObject(options)) {
    throw new TypeError('Invalid account input');
  }
  const timestamp = readTimestamp(options.timestamp);
  const account = String(input.account ?? '').trim();
  const record = {
    accountId: readAccountId(options),
    account,
    accountMasked: maskAccount(account),
    remark: normalizeRemark(input.remark),
    accessToken: input.accessToken,
    username: Object.hasOwn(input, 'username') ? input.username : '',
    savedAt: timestamp,
    updatedAt: timestamp,
  };
  return validateAccountRecord(record);
}

function updateAccountRecord(current, input, options = {}) {
  const existing = validateAccountRecord(current);
  if (!isPlainObject(input) || !isPlainObject(options)) {
    throw new TypeError('Invalid account update');
  }

  const account = Object.hasOwn(input, 'account')
    ? String(input.account ?? '').trim()
    : existing.account;
  if (account !== existing.account) {
    throw new TypeError('Cannot update credentials for a different account');
  }

  const timestamp = readTimestamp(options.timestamp);
  const record = {
    accountId: existing.accountId,
    account: existing.account,
    accountMasked: maskAccount(existing.account),
    remark: Object.hasOwn(input, 'remark') ? normalizeRemark(input.remark) : existing.remark,
    accessToken: Object.hasOwn(input, 'accessToken') ? input.accessToken : existing.accessToken,
    username: Object.hasOwn(input, 'username') ? input.username : existing.username,
    savedAt: existing.savedAt,
    updatedAt: Math.max(existing.updatedAt, timestamp),
  };
  return validateAccountRecord(record);
}

function toPublicAccount(record) {
  const privateRecord = validateAccountRecord(record);
  return validatePublicAccount({
    accountId: privateRecord.accountId,
    accountMasked: privateRecord.accountMasked,
    remark: privateRecord.remark,
    label: accountLabel(privateRecord),
    savedAt: privateRecord.savedAt,
    updatedAt: privateRecord.updatedAt,
  });
}

module.exports = {
  MAX_REMARK_LENGTH,
  accountLabel,
  createAccountRecord,
  maskAccount,
  normalizeRemark,
  toPublicAccount,
  updateAccountRecord,
  validateAccountRecord,
  validatePublicAccount,
};
