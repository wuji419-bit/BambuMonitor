const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDeviceCredentialStore } = require('./device-credential-store.cjs');

test('encrypts desktop camera credentials and restores them after restart', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-device-credentials-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const protection = {
    protect: (value) => Buffer.from(`protected:${value}`),
    unprotect: (value) => Buffer.from(value).toString().replace(/^protected:/, ''),
  };

  const first = createDeviceCredentialStore({ userDataPath, protection });
  first.update(' serial-a ', { accessCode: ' camera-secret ' });
  first.update(' serial-a ', { ip: ' 192.168.1.20 ' });

  const stored = fs.readFileSync(path.join(userDataPath, 'bambu-device-credentials.json'), 'utf8');
  assert.equal(stored.includes('192.168.1.20'), false);
  assert.equal(stored.includes('camera-secret'), false);

  const restarted = createDeviceCredentialStore({ userDataPath, protection });
  assert.deepEqual(restarted.get('SERIAL-A'), {
    ip: '192.168.1.20',
    accessCode: 'camera-secret',
  });
});
