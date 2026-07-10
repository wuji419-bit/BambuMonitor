import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraCardPresentation, cameraRetryLabel, nextCameraFit } from './cameraPresentation.js';

test('presents ready custom and automatic cameras truthfully', () => {
  assert.deepEqual(buildCameraCardPresentation({ imageState: { status: 'ready' }, customUrl: 'http://camera' }), { label: '自定义', message: '', showRetry: false });
  assert.equal(buildCameraCardPresentation({ imageState: { status: 'ready' } }).label, '有画面');
});

test('presents pending, manual, error, and no-IP states', () => {
  assert.equal(buildCameraCardPresentation({ stream: { pending: true }, hasIp: true }).label, '连接中');
  assert.equal(buildCameraCardPresentation({ imageState: { status: 'manual', message: '请配置' }, hasIp: true }).label, '需配置');
  assert.deepEqual(buildCameraCardPresentation({ imageState: { status: 'error', message: '失败' }, hasIp: true }), { label: '无画面', message: '失败', showRetry: true });
  assert.equal(buildCameraCardPresentation({}).message, '需要本地 IP 才能自动打开');
});

test('builds printer-specific retry labels', () => {
  assert.equal(cameraRetryLabel({ name: 'A1 mini' }), '重试 A1 mini 摄像头');
  assert.equal(cameraRetryLabel({}), '重试 未命名打印机 摄像头');
});

test('toggles fit and resets unknown values to contain', () => {
  assert.equal(nextCameraFit('contain'), 'cover');
  assert.equal(nextCameraFit('cover'), 'contain');
  assert.equal(nextCameraFit('unexpected'), 'contain');
});
