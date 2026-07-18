const { extractBambuUsername } = require('../electron/mqtt-options.cjs');

const BAMBU_API = Object.freeze({
  LOGIN: 'https://api.bambulab.cn/v1/user-service/user/login',
  EMAIL_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendemail/code',
  SMS_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendsmscode',
  BIND: 'https://api.bambulab.cn/v1/iot-service/api/user/bind',
  PREFERENCE: 'https://api.bambulab.cn/v1/design-user-service/my/preference',
});

const ERROR_TRANSLATIONS = Object.freeze({
  'Incorrect password': '密码错误',
  'incorrect password': '密码错误',
  'This account is not registered': '此账号未注册',
  'Account not found': '账号不存在',
  'Code does not exist or has expired': '验证码已过期或不存在',
  'Incorrect code': '验证码错误',
  'Invalid phone number': '手机号格式错误',
  'Enter a valid phone number': '请输入有效的手机号',
  'Network error': '网络错误',
  'Request failed': '请求失败',
});

class BambuCloudError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BambuCloudError';
    this.status = status;
    this.tokenInvalid = status === 401 || status === 403;
  }
}

function getBambuHeaders() {
  return {
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
  };
}

function translateBambuError(errorMsg) {
  if (!errorMsg) return '';

  const message = String(errorMsg);
  if (ERROR_TRANSLATIONS[message]) {
    return ERROR_TRANSLATIONS[message];
  }

  const lowerMessage = message.toLowerCase();
  for (const [english, chinese] of Object.entries(ERROR_TRANSLATIONS)) {
    if (lowerMessage.includes(english.toLowerCase())) {
      return chinese;
    }
  }

  return message;
}

function createBambuCloudClient({ fetchImpl = global.fetch, logger } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Bambu Cloud client requires fetch');
  }

  const logHttp = (operation, status, deviceCount) => {
    if (!logger || typeof logger.info !== 'function') return;

    const entry = { operation };
    if (typeof status === 'number') entry.status = status;
    if (typeof deviceCount === 'number') entry.deviceCount = deviceCount;
    try {
      logger.info(entry);
    } catch {
      // Diagnostics must never change a cloud operation's behavior.
    }
  };

  const isTokenInvalidResponse = (response) => (
    response?.status === 401 || response?.status === 403
  );

  const readJson = async (response) => {
    try {
      return await response.json();
    } catch (error) {
      if (isTokenInvalidResponse(response)) {
        throw new BambuCloudError('Bambu Cloud authentication failed', response.status);
      }
      throw error;
    }
  };

  const throwIfTokenInvalid = (response, data) => {
    if (!isTokenInvalidResponse(response)) return;

    const message = data?.error || data?.message || 'Bambu Cloud authentication failed';
    throw new BambuCloudError(String(message), response.status);
  };

  async function loginPassword({ account, password }) {
    try {
      const response = await fetchImpl(BAMBU_API.LOGIN, {
        method: 'POST',
        headers: getBambuHeaders(),
        body: JSON.stringify({ account, password, apiError: '' }),
      });
      const data = await readJson(response);
      logHttp('bambu-cloud.login-password', response.status);

      if (data.accessToken) {
        return { success: true, accessToken: data.accessToken };
      }
      if (data.loginType === 'verifyCode') {
        return { success: false, needVerifyCode: true, message: '需要验证码' };
      }
      if (data.loginType === 'tfa') {
        return {
          success: false,
          needTfa: true,
          tfaKey: data.tfaKey,
          message: '需要两步验证码',
        };
      }

      return { success: false, error: translateBambuError(data.error) || '登录失败' };
    } catch (error) {
      return { success: false, error: translateBambuError(error?.message) };
    }
  }

  async function requestVerifyCode({ account }) {
    try {
      const normalizedAccount = account.toString().replace(/\s+/g, '');
      const isEmail = normalizedAccount.includes('@');
      const url = isEmail ? BAMBU_API.EMAIL_CODE : BAMBU_API.SMS_CODE;
      const body = isEmail
        ? { email: normalizedAccount, type: 'codeLogin' }
        : { phone: normalizedAccount, type: 'codeLogin' };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: getBambuHeaders(),
        body: JSON.stringify(body),
      });
      logHttp('bambu-cloud.request-verify-code', response.status);

      if (response.ok) {
        return {
          success: true,
          message: isEmail ? '验证码已发送到您的邮箱' : '验证码已发送到您的手机',
        };
      }

      const data = await readJson(response);
      return { success: false, error: translateBambuError(data.error) || '发送验证码失败' };
    } catch (error) {
      return { success: false, error: translateBambuError(error?.message) };
    }
  }

  async function loginCode({ account, code }) {
    try {
      const normalizedAccount = account.toString().replace(/\s+/g, '');
      const isEmail = normalizedAccount.includes('@');
      const body = { code };

      if (isEmail) {
        body.email = normalizedAccount;
      } else {
        body.account = normalizedAccount;
        body.loginType = 'phone';
      }

      const response = await fetchImpl(BAMBU_API.LOGIN, {
        method: 'POST',
        headers: getBambuHeaders(),
        body: JSON.stringify(body),
      });
      const data = await readJson(response);
      logHttp('bambu-cloud.login-code', response.status);

      if (data.accessToken) {
        return { success: true, accessToken: data.accessToken };
      }
      if (data.code === 1) {
        return { success: false, codeExpired: true, error: '验证码已过期或无效' };
      }
      if (data.code === 2) {
        return { success: false, error: '验证码错误' };
      }

      return {
        success: false,
        error: translateBambuError(data.error || data.message) || '登录失败',
      };
    } catch (error) {
      return { success: false, error: translateBambuError(error?.message) };
    }
  }

  async function getCloudUsername(accessToken) {
    const tokenUsername = extractBambuUsername(accessToken);
    if (tokenUsername) return tokenUsername;

    try {
      const response = await fetchImpl(BAMBU_API.PREFERENCE, {
        method: 'GET',
        headers: {
          ...getBambuHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const data = await readJson(response);
      logHttp('bambu-cloud.get-username', response.status);
      throwIfTokenInvalid(response, data);
      return data?.uid ? `u_${data.uid}` : '';
    } catch (error) {
      if (error instanceof BambuCloudError) throw error;
      return '';
    }
  }

  async function listDevices(accessToken) {
    try {
      const response = await fetchImpl(BAMBU_API.BIND, {
        method: 'GET',
        headers: {
          ...getBambuHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const data = await readJson(response);
      const devicePayload = data?.devices;
      const deviceCount = Array.isArray(devicePayload) ? devicePayload.length : 0;
      logHttp('bambu-cloud.list-devices', response.status, deviceCount);
      throwIfTokenInvalid(response, data);

      if (devicePayload) {
        const username = await getCloudUsername(accessToken);
        const devices = devicePayload.map((device) => ({
          id: device.dev_id,
          name: device.name,
          model: device.dev_product_name || device.dev_model_name,
          modelCode: device.dev_model_name,
          accessCode: device.dev_access_code,
          online: device.online,
          printStatus: device.print_status,
          nozzle: device.nozzle_diameter,
        }));
        return { success: true, devices, username };
      }

      return { success: false, error: data?.error || '获取设备列表失败' };
    } catch (error) {
      if (error instanceof BambuCloudError) throw error;
      return { success: false, error: error?.message };
    }
  }

  return {
    loginPassword,
    requestVerifyCode,
    loginCode,
    listDevices,
    getCloudUsername,
  };
}

module.exports = {
  BAMBU_API,
  BambuCloudError,
  createBambuCloudClient,
  getBambuHeaders,
  translateBambuError,
};
