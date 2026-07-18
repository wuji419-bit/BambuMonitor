const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BAMBU_API,
  BambuCloudError,
  createBambuCloudClient,
  getBambuHeaders,
  translateBambuError,
} = require('./bambu-cloud.cjs');

function jsonResponse(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function createCapturingLogger() {
  const entries = [];
  const capture = (level) => (...args) => entries.push({ level, args });
  return {
    entries,
    logger: {
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
  };
}

function assertSafeLogEntries(entries, secrets) {
  const serialized = JSON.stringify(entries);

  for (const secret of secrets) {
    assert.equal(
      serialized.includes(secret),
      false,
      `logger output exposed secret: ${secret}`,
    );
  }

  for (const entry of entries) {
    assert.equal(entry.args.length, 1);
    assert.equal(typeof entry.args[0], 'object');
    assert.notEqual(entry.args[0], null);
    for (const key of Object.keys(entry.args[0])) {
      assert.ok(
        ['operation', 'status', 'deviceCount'].includes(key),
        `unexpected logger field: ${key}`,
      );
    }
  }
}

test('exports the existing Bambu China endpoints and OrcaSlicer headers', () => {
  assert.deepEqual(BAMBU_API, {
    LOGIN: 'https://api.bambulab.cn/v1/user-service/user/login',
    EMAIL_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendemail/code',
    SMS_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendsmscode',
    BIND: 'https://api.bambulab.cn/v1/iot-service/api/user/bind',
    PREFERENCE: 'https://api.bambulab.cn/v1/design-user-service/my/preference',
  });
  assert.deepEqual(getBambuHeaders(), {
    'User-Agent': 'bambu_network_agent/01.09.05.01',
    'X-BBL-Client-Name': 'OrcaSlicer',
    'X-BBL-Client-Type': 'slicer',
    'X-BBL-Client-Version': '01.09.05.51',
    'X-BBL-Language': 'zh-CN',
    'X-BBL-OS-Type': 'windows',
    'X-BBL-OS-Version': '10.0',
    'X-BBL-Agent-Version': '01.09.05.01',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
});

test('password login returns the access token and sends the existing body', async () => {
  const calls = [];
  const client = createBambuCloudClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { accessToken: 'password-token' });
    },
  });

  assert.deepEqual(await client.loginPassword({
    account: 'user@example.com',
    password: 'password-secret',
  }), {
    success: true,
    accessToken: 'password-token',
  });
  assert.equal(calls[0].url, BAMBU_API.LOGIN);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    account: 'user@example.com',
    password: 'password-secret',
    apiError: '',
  });
});

test('logger output never contains credentials, tokens, codes, access codes, or credential URLs', async () => {
  const account = 'private-account@example.com';
  const phone = '13800138000';
  const password = 'private-password';
  const emailCode = '849201';
  const phoneCode = '739102';
  const passwordToken = 'password-access-token';
  const codeToken = 'code-access-token';
  const deviceToken = 'device-access-token';
  const accessCode = '87654321';
  const credentialUrl = `https://credentials.invalid/login?account=${account}&token=${deviceToken}`;
  const calls = [];
  const { entries, logger } = createCapturingLogger();
  const client = createBambuCloudClient({
    logger,
    fetchImpl: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, options, body });

      if (body?.account === 'trigger-credential-url-error') {
        throw new Error(credentialUrl);
      }
      if (url === BAMBU_API.EMAIL_CODE || url === BAMBU_API.SMS_CODE) {
        return jsonResponse(200, {});
      }
      if (url === BAMBU_API.LOGIN && body?.password) {
        return jsonResponse(200, { accessToken: passwordToken });
      }
      if (url === BAMBU_API.LOGIN && body?.code) {
        return jsonResponse(200, { accessToken: codeToken });
      }
      if (url === BAMBU_API.BIND) {
        return jsonResponse(200, {
          devices: [{ dev_id: 'SERIAL-1', dev_access_code: accessCode }],
        });
      }
      if (url === BAMBU_API.PREFERENCE) {
        return jsonResponse(200, { uid: '42' });
      }
      throw new Error('Unexpected request');
    },
  });

  await client.loginPassword({ account, password });
  await client.requestVerifyCode({ account });
  await client.requestVerifyCode({ account: phone });
  await client.loginCode({ account, code: emailCode });
  await client.loginCode({ account: phone, code: phoneCode });
  await client.listDevices(deviceToken);
  await client.loginPassword({ account: 'trigger-credential-url-error', password });

  assert.ok(calls.some((call) => call.body?.account === account && call.body?.password === password));
  assert.ok(calls.some((call) => call.body?.email === account && call.body?.type === 'codeLogin'));
  assert.ok(calls.some((call) => call.body?.phone === phone && call.body?.type === 'codeLogin'));
  assert.ok(calls.some((call) => call.body?.email === account && call.body?.code === emailCode));
  assert.ok(calls.some((call) => call.body?.account === phone && call.body?.code === phoneCode));
  assert.ok(calls.some((call) => call.options?.headers?.Authorization === `Bearer ${deviceToken}`));
  assert.ok(entries.length > 0);
  assertSafeLogEntries(entries, [
    account,
    phone,
    password,
    emailCode,
    phoneCode,
    passwordToken,
    codeToken,
    deviceToken,
    accessCode,
    credentialUrl,
  ]);
});

test('password login preserves verification-code and TFA result shapes', async () => {
  const responses = [
    jsonResponse(200, { loginType: 'verifyCode' }),
    jsonResponse(200, { loginType: 'tfa', tfaKey: 'tfa-key' }),
  ];
  const client = createBambuCloudClient({ fetchImpl: async () => responses.shift() });

  assert.deepEqual(await client.loginPassword({ account: 'a', password: 'b' }), {
    success: false,
    needVerifyCode: true,
    message: '需要验证码',
  });
  assert.deepEqual(await client.loginPassword({ account: 'a', password: 'b' }), {
    success: false,
    needTfa: true,
    tfaKey: 'tfa-key',
    message: '需要两步验证码',
  });
});

test('verification-code requests support normalized email and phone accounts', async () => {
  const calls = [];
  const client = createBambuCloudClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {});
    },
  });

  assert.deepEqual(await client.requestVerifyCode({ account: ' user @ example.com ' }), {
    success: true,
    message: '验证码已发送到您的邮箱',
  });
  assert.deepEqual(await client.requestVerifyCode({ account: ' 138 0013 8000 ' }), {
    success: true,
    message: '验证码已发送到您的手机',
  });
  assert.equal(calls[0].url, BAMBU_API.EMAIL_CODE);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email: 'user@example.com',
    type: 'codeLogin',
  });
  assert.equal(calls[1].url, BAMBU_API.SMS_CODE);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    phone: '13800138000',
    type: 'codeLogin',
  });
});

test('code login supports normalized email and phone accounts', async () => {
  const calls = [];
  const client = createBambuCloudClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { accessToken: `token-${calls.length}` });
    },
  });

  assert.deepEqual(await client.loginCode({ account: ' user @ example.com ', code: '112233' }), {
    success: true,
    accessToken: 'token-1',
  });
  assert.deepEqual(await client.loginCode({ account: ' 138 0013 8000 ', code: '445566' }), {
    success: true,
    accessToken: 'token-2',
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    code: '112233',
    email: 'user@example.com',
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    code: '445566',
    account: '13800138000',
    loginType: 'phone',
  });
});

test('code login and translated errors preserve the current Chinese UI behavior', async () => {
  assert.equal(translateBambuError('Incorrect password'), '密码错误');
  assert.equal(translateBambuError('API: incorrect password, retry'), '密码错误');
  assert.equal(translateBambuError('This account is not registered'), '此账号未注册');
  assert.equal(translateBambuError('Account not found'), '账号不存在');
  assert.equal(translateBambuError('Code does not exist or has expired'), '验证码已过期或不存在');
  assert.equal(translateBambuError('Incorrect code'), '验证码错误');
  assert.equal(translateBambuError('Invalid phone number'), '手机号格式错误');
  assert.equal(translateBambuError('Enter a valid phone number'), '请输入有效的手机号');
  assert.equal(translateBambuError('Network error'), '网络错误');
  assert.equal(translateBambuError('Request failed'), '请求失败');
  assert.equal(translateBambuError('Untranslated service error'), 'Untranslated service error');
  assert.equal(translateBambuError(''), '');

  const responses = [
    jsonResponse(401, { error: 'Incorrect password' }),
    jsonResponse(400, { code: 1 }),
    jsonResponse(400, { code: 2 }),
    jsonResponse(400, { message: 'Account not found' }),
    jsonResponse(400, { error: 'Invalid phone number' }),
  ];
  const client = createBambuCloudClient({ fetchImpl: async () => responses.shift() });

  assert.deepEqual(await client.loginPassword({ account: 'a', password: 'b' }), {
    success: false,
    error: '密码错误',
  });
  assert.deepEqual(await client.loginCode({ account: 'a@b.c', code: '1' }), {
    success: false,
    codeExpired: true,
    error: '验证码已过期或无效',
  });
  assert.deepEqual(await client.loginCode({ account: 'a@b.c', code: '2' }), {
    success: false,
    error: '验证码错误',
  });
  assert.deepEqual(await client.loginCode({ account: 'a@b.c', code: '3' }), {
    success: false,
    error: '账号不存在',
  });
  assert.deepEqual(await client.requestVerifyCode({ account: '13800138000' }), {
    success: false,
    error: '手机号格式错误',
  });
});

test('device list normalization and preference fallback match Electron behavior', async () => {
  const calls = [];
  const { entries, logger } = createCapturingLogger();
  const responses = [
    jsonResponse(200, {
      devices: [
        {
          dev_id: '01P',
          name: 'Workshop P1S',
          dev_product_name: 'P1S',
          dev_model_name: 'C12',
          dev_access_code: '12345678',
          online: true,
          print_status: 'RUNNING',
          nozzle_diameter: 0.4,
        },
        {
          dev_id: '01A',
          name: 'Desk A1',
          dev_model_name: 'N2S',
          dev_access_code: '23456789',
          online: false,
        },
      ],
    }),
    jsonResponse(200, { uid: '42' }),
  ];
  const client = createBambuCloudClient({
    logger,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.deepEqual(await client.listDevices('opaque-access-token'), {
    success: true,
    username: 'u_42',
    devices: [
      {
        id: '01P',
        name: 'Workshop P1S',
        model: 'P1S',
        modelCode: 'C12',
        accessCode: '12345678',
        online: true,
        printStatus: 'RUNNING',
        nozzle: 0.4,
      },
      {
        id: '01A',
        name: 'Desk A1',
        model: 'N2S',
        modelCode: 'N2S',
        accessCode: '23456789',
        online: false,
        printStatus: undefined,
        nozzle: undefined,
      },
    ],
  });
  assert.equal(calls[0].url, BAMBU_API.BIND);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer opaque-access-token');
  assert.equal(calls[1].url, BAMBU_API.PREFERENCE);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer opaque-access-token');
  assertSafeLogEntries(entries, [
    'opaque-access-token',
    '12345678',
    '23456789',
  ]);
  assert.ok(entries.some((entry) => entry.args[0].deviceCount === 2));
});

test('cloud username comes from the token without calling the preference endpoint', async () => {
  const token = makeJwt({ username: 'u_2468' });
  const client = createBambuCloudClient({
    fetchImpl: async () => {
      throw new Error('preference endpoint should not be called');
    },
  });

  assert.equal(await client.getCloudUsername(token), 'u_2468');
});

test('401 and 403 device or preference responses throw token-invalid BambuCloudError instances', async () => {
  const bindClient = createBambuCloudClient({
    fetchImpl: async () => jsonResponse(401, null),
  });
  await assert.rejects(
    bindClient.listDevices('expired-token'),
    (error) => {
      assert.ok(error instanceof BambuCloudError);
      assert.equal(error.status, 401);
      assert.equal(error.tokenInvalid, true);
      return true;
    },
  );

  const responses = [
    jsonResponse(200, { devices: [] }),
    jsonResponse(403, { error: 'Forbidden' }),
  ];
  const preferenceClient = createBambuCloudClient({
    fetchImpl: async () => responses.shift(),
  });
  await assert.rejects(
    preferenceClient.listDevices('revoked-token'),
    (error) => {
      assert.ok(error instanceof BambuCloudError);
      assert.equal(error.status, 403);
      assert.equal(error.tokenInvalid, true);
      return true;
    },
  );
});
