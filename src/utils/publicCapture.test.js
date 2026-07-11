import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicCaptureSearch, publicCameraAddress } from './publicCapture.js';

test('recognizes only the explicit public capture query', () => {
  assert.equal(isPublicCaptureSearch('?capture=public'), true);
  assert.equal(isPublicCaptureSearch('?preview=dashboard&capture=public'), true);
  assert.equal(isPublicCaptureSearch('?capture=private'), false);
  assert.equal(isPublicCaptureSearch(''), false);
});

test('redacts camera addresses only for public capture', () => {
  assert.equal(publicCameraAddress('192.168.1.143', true), '本地摄像头');
  assert.equal(publicCameraAddress('192.168.1.143', false), 'IP 192.168.1.143');
  assert.equal(publicCameraAddress('', false), '暂无本地 IP');
});
