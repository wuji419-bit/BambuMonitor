import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraAddressLabel, buildCameraCardPresentation, cameraFitReducer, cameraRetryLabel, nextCameraFit, shouldClearCameraZoom } from './cameraPresentation.js';

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

test('presents preview cameras without offering a retry', () => {
  assert.deepEqual(buildCameraCardPresentation({
    imageState: { status: 'preview', message: '演示模式不连接真实摄像头' },
  }), {
    label: '演示',
    message: '演示模式不连接真实摄像头',
    showRetry: false,
  });
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

test('preserves fit for the same camera and resets it for a new camera', () => {
  const cameraA = { imageKey: 'camera-a', fit: 'cover' };
  assert.equal(cameraFitReducer(cameraA, { type: 'sync', imageKey: 'camera-a' }), cameraA);
  assert.deepEqual(cameraFitReducer(cameraA, { type: 'sync', imageKey: 'camera-b' }), { imageKey: 'camera-b', fit: 'contain' });
});

test('camera fit reducer toggles contain and cover', () => {
  assert.deepEqual(cameraFitReducer({ imageKey: 'camera-a', fit: 'contain' }, { type: 'toggle' }), { imageKey: 'camera-a', fit: 'cover' });
  assert.deepEqual(cameraFitReducer({ imageKey: 'camera-a', fit: 'cover' }, { type: 'toggle' }), { imageKey: 'camera-a', fit: 'contain' });
});

test('clears selected zoom when key or printer is missing', () => {
  assert.equal(shouldClearCameraZoom({ selectedKey: '', printer: null, zoomState: null }), false);
  assert.equal(shouldClearCameraZoom({ selectedKey: 'camera-a', printer: null, zoomState: null }), true);
});

test('clears selected zoom when its image becomes non-zoomable', () => {
  assert.equal(shouldClearCameraZoom({ selectedKey: 'camera-a', printer: {}, zoomState: { canZoom: false } }), true);
});

test('retains a valid selected zoom', () => {
  assert.equal(shouldClearCameraZoom({ selectedKey: 'camera-a', printer: {}, zoomState: { canZoom: true } }), false);
});

test('Web camera labels use local-address presence without rendering the raw IP', () => {
  const printer = { ip: '192.168.1.143', hasLocalAddress: true };
  const webLabel = buildCameraAddressLabel(printer, { showRawAddress: false });
  assert.equal(webLabel, '已配置本地地址');
  assert.equal(webLabel.includes(printer.ip), false);
  assert.equal(buildCameraAddressLabel(printer, { showRawAddress: true }), 'IP 192.168.1.143');
});
