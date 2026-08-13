const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accountLabel,
  createAccountRecord,
  maskAccount,
  normalizeRemark,
  toPublicAccount,
  updateAccountRecord,
  validateAccountRecord,
  validatePublicAccount,
} = require('./account-records.cjs');

test('normalizes optional remarks without splitting Unicode code points', () => {
  assert.equal(normalizeRemark('  公司账号  '), '公司账号');
  assert.equal(normalizeRemark('   '), '');
  assert.equal(normalizeRemark('🚀'.repeat(45)), '🚀'.repeat(40));
  assert.equal(Array.from(normalizeRemark('🚀'.repeat(45))).length, 40);
});

test('masks phone, email, and other account identifiers safely', () => {
  assert.equal(maskAccount('13812345678'), '138****5678');
  assert.equal(maskAccount('maker@example.com'), 'm***@example.com');
  assert.equal(maskAccount('custom-account'), 'cu***nt');
  assert.equal(maskAccount(''), '***');
  assert.equal(maskAccount('abc'), '***');
});

test('creates a validated private record with a generated stable account id', () => {
  let randomCalls = 0;
  const record = createAccountRecord({
    account: ' maker@example.com ',
    accessToken: 'secret-token',
    username: 'maker',
    remark: ' 公司 ',
  }, {
    randomId: () => {
      randomCalls += 1;
      return 'acc-random';
    },
    timestamp: 100,
  });

  assert.deepEqual(record, {
    accountId: 'acc-random',
    account: 'maker@example.com',
    accountMasked: 'm***@example.com',
    remark: '公司',
    accessToken: 'secret-token',
    username: 'maker',
    savedAt: 100,
    updatedAt: 100,
  });
  assert.equal(randomCalls, 1);
  assert.deepEqual(validateAccountRecord(record), record);
});

test('refreshes duplicate credentials without changing identity or an omitted remark', () => {
  const original = createAccountRecord({
    account: 'maker@example.com',
    accessToken: 'token-one',
    username: 'maker-one',
    remark: '公司',
  }, { accountId: 'acc-1', timestamp: 100 });

  const refreshed = updateAccountRecord(original, {
    account: 'maker@example.com',
    accessToken: 'token-two',
    username: 'maker-two',
  }, { timestamp: 200 });

  assert.deepEqual(refreshed, {
    accountId: 'acc-1',
    account: 'maker@example.com',
    accountMasked: 'm***@example.com',
    remark: '公司',
    accessToken: 'token-two',
    username: 'maker-two',
    savedAt: 100,
    updatedAt: 200,
  });
});

test('an explicitly provided refresh remark replaces the existing remark', () => {
  const original = createAccountRecord({
    account: 'maker@example.com',
    accessToken: 'token-one',
    username: 'maker',
    remark: '公司',
  }, { accountId: 'acc-1', timestamp: 100 });

  const refreshed = updateAccountRecord(original, {
    accessToken: 'token-two',
    remark: '   ',
  }, { timestamp: 200 });

  assert.equal(refreshed.remark, '');
  assert.equal(refreshed.accountId, original.accountId);
  assert.equal(refreshed.savedAt, original.savedAt);
});

test('public records prefer remarks and never expose credentials', () => {
  const record = createAccountRecord({
    account: '13812345678',
    accessToken: 'secret-token',
    username: 'private-username',
    remark: '公司',
  }, { accountId: 'acc-1', timestamp: 100 });

  const publicRecord = toPublicAccount(record);
  assert.deepEqual(publicRecord, {
    accountId: 'acc-1',
    accountMasked: '138****5678',
    remark: '公司',
    label: '公司',
    savedAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(validatePublicAccount(publicRecord), publicRecord);
  assert.equal(accountLabel({ ...record, remark: '' }), '138****5678');

  const json = JSON.stringify(publicRecord);
  assert.equal(json.includes('13812345678'), false);
  assert.equal(json.includes('secret-token'), false);
  assert.equal(json.includes('private-username'), false);
  assert.equal(Object.hasOwn(publicRecord, 'account'), false);
  assert.equal(Object.hasOwn(publicRecord, 'accessToken'), false);
  assert.equal(Object.hasOwn(publicRecord, 'username'), false);
});

test('strict validators reject malformed or over-permissive records', () => {
  const record = createAccountRecord({
    account: 'maker@example.com',
    accessToken: 'secret-token',
  }, { accountId: 'acc-1', timestamp: 100 });
  const publicRecord = toPublicAccount(record);

  assert.throws(
    () => validateAccountRecord({ ...record, extra: true }),
    /Invalid account record/,
  );
  assert.throws(
    () => validateAccountRecord({ ...record, accountMasked: 'maker@example.com' }),
    /Invalid account record/,
  );
  assert.throws(
    () => validatePublicAccount({ ...publicRecord, accessToken: 'leak' }),
    /Invalid public account/,
  );
  assert.throws(
    () => updateAccountRecord(record, { account: 'other@example.com' }),
    /different account/,
  );
});

test('public account validation rejects an unmasked account-looking value', () => {
  const record = createAccountRecord({
    account: 'maker@example.com',
    accessToken: 'secret-token',
  }, { accountId: 'acc-1', timestamp: 100 });
  const publicRecord = toPublicAccount(record);

  assert.throws(
    () => validatePublicAccount({
      ...publicRecord,
      accountMasked: 'maker@example.com',
      label: 'maker@example.com',
    }),
    /Invalid public account/,
  );
});

test('desktop package includes both shared multi-account core modules', () => {
  const packageJson = require('../package.json');

  assert.equal(packageJson.build.files.includes('core/account-records.cjs'), true);
  assert.equal(packageJson.build.files.includes('core/device-aggregation.cjs'), true);
});
