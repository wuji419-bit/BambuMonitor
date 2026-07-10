import test from 'node:test';
import assert from 'node:assert/strict';
import { cachePrinterAddress, isValidPrinterAddress } from './printerAddress.js';

test('accepts IPv4, IPv6, hostnames, and Tailscale names', () => {
  for (const value of ['192.168.1.20', 'fd7a:115c:a1e0::12', 'printer.local', 'a1-mini.tailnet.ts.net']) assert.equal(isValidPrinterAddress(value), true, value);
});
test('rejects arbitrary strings, URLs, ports, and invalid IPv4', () => {
  for (const value of ['', 'printer', 'hello world', 'http://printer', 'printer.local:6000', '999.1.2.3', '::::']) assert.equal(isValidPrinterAddress(value), false, value);
});
test('cache helper only changes a returned copy', () => {
  const original = {};
  const next = cachePrinterAddress(original, { dev_id: '1', cloudId: 'c1', name: 'A1 Mini' }, '10.0.0.2');
  assert.deepEqual(original, {});
  assert.equal(next.c1, '10.0.0.2');
  assert.equal(next.a1mini, '10.0.0.2');
});
