const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChamberAuthPacket,
  createChamberFrameParser,
  isChamberImageCamera,
} = require('./camera-stream.cjs');

test('builds Bambu chamber-image auth packet', () => {
  const packet = buildChamberAuthPacket('123456789');

  assert.equal(packet.length, 80);
  assert.equal(packet.readUInt32LE(0), 0x40);
  assert.equal(packet.readUInt32LE(4), 0x3000);
  assert.equal(packet.subarray(16, 20).toString('ascii'), 'bblp');
  assert.equal(packet.subarray(48, 57).toString('ascii'), '123456789');
});

test('detects P1/A1/A2 chamber-image camera models', () => {
  assert.equal(isChamberImageCamera({ name: 'A1mini' }), true);
  assert.equal(isChamberImageCamera({ name: 'P1SC' }), true);
  assert.equal(isChamberImageCamera({ name: 'A2L01' }), true);
  assert.equal(isChamberImageCamera({ name: 'H2D', model: 'H2D' }), false);
});

test('parses split chamber-image JPEG frames', () => {
  const frames = [];
  const warnings = [];
  const parser = createChamberFrameParser({
    onFrame: (frame) => frames.push(frame),
    onWarn: (warning) => warnings.push(warning),
  });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
  const header = Buffer.alloc(16, 0);
  header.writeUIntLE(jpeg.length, 0, 3);

  parser(Buffer.concat([header.subarray(0, 7)]));
  parser(Buffer.concat([header.subarray(7), jpeg.subarray(0, 3)]));
  parser(jpeg.subarray(3));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg);
  assert.deepEqual(warnings, []);
});

test('accepts JPEG frames with non-APP0 headers', () => {
  const frames = [];
  const parser = createChamberFrameParser({
    onFrame: (frame) => frames.push(frame),
  });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x03, 0x04, 0xff, 0xd9]);
  const header = Buffer.alloc(16, 0);
  header.writeUIntLE(jpeg.length, 0, 3);

  parser(Buffer.concat([header, jpeg]));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg);
});
