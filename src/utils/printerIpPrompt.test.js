import test from 'node:test';
import assert from 'node:assert/strict';

import { hasCloudStatus, shouldPromptForPrinterIp } from './printerIpPrompt.js';

test('does not prompt for IP when printer is already using cloud status', () => {
  assert.equal(shouldPromptForPrinterIp({
    name: 'A2L01',
    status: 'finished',
    statusSource: 'cloud',
    connectionMode: 'cloud',
    ip: '',
  }), false);
});

test('prompts for IP only for non-cloud local status gaps', () => {
  assert.equal(shouldPromptForPrinterIp({
    name: 'Legacy local printer',
    status: 'no_ip',
    statusSource: 'local',
    ip: '',
  }), true);
});

test('recognizes cloud status from source, mode, or legacy cloud state', () => {
  assert.equal(hasCloudStatus({ statusSource: 'cloud' }), true);
  assert.equal(hasCloudStatus({ connectionMode: 'cloud' }), true);
  assert.equal(hasCloudStatus({ status: 'cloud_overview' }), true);
  assert.equal(hasCloudStatus({ status: 'printing', statusSource: 'local' }), false);
});

test('uses the public hasLocalAddress flag when Web devices omit raw IP', () => {
  assert.equal(shouldPromptForPrinterIp({
    status: 'no_ip',
    statusSource: 'local',
    hasLocalAddress: true,
  }), false);
});

test('preserves the Electron no-IP status prompt even when a stale address remains', () => {
  assert.equal(shouldPromptForPrinterIp({
    status: 'no_ip',
    statusSource: 'local',
    ip: '192.168.1.20',
  }), true);
});
