import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('package metadata exposes the NAS commands at version 1.1.1', async () => {
  const [manifest, lockfile] = await Promise.all([
    read('package.json').then(JSON.parse),
    read('package-lock.json').then(JSON.parse),
  ]);

  assert.equal(manifest.version, '1.1.1');
  assert.equal(lockfile.version, '1.1.1');
  assert.equal(lockfile.packages[''].version, '1.1.1');
  assert.equal(manifest.scripts.server, 'node server/index.js');
  assert.equal(manifest.scripts['server:dev'], 'concurrently -k "vite --host 0.0.0.0" "node --watch server/index.js"');
  assert.equal(manifest.scripts['docker:smoke'], 'node scripts/docker-smoke.mjs');
  assert.match(manifest.scripts['test:nas'], /scripts\/docker-smoke\.test\.mjs/);
  assert.match(manifest.scripts['test:nas'], /scripts\/nas-package\.test\.mjs/);
});

test('Dockerfile is a Node 22 multi-stage build with a minimal non-root runtime', async () => {
  const dockerfile = await read('Dockerfile');

  assert.equal((dockerfile.match(/^FROM node:22-bookworm-slim AS /gm) ?? []).length, 2);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build[\s\S]*npm ci[\s\S]*npm run build/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends\s*\\?\s*ffmpeg\s*\\?\s*tini\s*\\?\s*ca-certificates/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /COPY --from=build \/app\/node_modules/);
  for (const required of ['dist', 'server', 'core', 'src/utils', 'electron/camera-stream.cjs']) {
    assert.match(dockerfile, new RegExp(`COPY --from=build(?: --chown=node:node)? /app/${required.replace(/[./]/g, '\\$&')}`));
  }
  assert.match(dockerfile, /ENV NODE_ENV=production PORT=3080 DATA_DIR=\/app\/data/);
  assert.match(dockerfile, /EXPOSE 3080/);
  assert.match(dockerfile, /VOLUME \["\/app\/data"\]/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini","--"\]/);
  assert.match(dockerfile, /CMD \["node","server\/index\.js"\]/);
  assert.match(dockerfile, /HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD \["node","server\/healthcheck\.js"\]/);
});

test('compose.yaml defines only the host-networked BambuMonitor service and persistent data', async () => {
  const compose = await read('compose.yaml');

  assert.equal(compose, `services:\n  bambu-monitor:\n    image: ghcr.io/wuji419-bit/bambu-monitor:latest\n    container_name: bambu-monitor\n    network_mode: host\n    restart: unless-stopped\n    environment:\n      PORT: 3080\n      DATA_DIR: /app/data\n      TZ: Asia/Shanghai\n      TRUST_PROXY: "0"\n    volumes:\n      - ./data:/app/data\n`);
  assert.doesNotMatch(compose, /ports:|cloudflare|caddy|nginx|database/i);
});

test('.dockerignore removes generated and media-heavy context while retaining runtime sources', async () => {
  const ignored = (await read('.dockerignore')).split(/\r?\n/).filter(Boolean);

  for (const entry of ['.git', '.worktrees', 'node_modules', 'dist', 'release', 'output', 'logs', 'docs/media/video']) {
    assert.ok(ignored.includes(entry), `missing ${entry}`);
  }
  for (const required of ['package.json', 'package-lock.json', 'server', 'core', 'src', 'electron']) {
    assert.ok(!ignored.includes(required), `${required} must remain in the build context`);
  }
});

test('.dockerignore excludes only the root Compose data directory', async () => {
  const ignored = (await read('.dockerignore')).split(/\r?\n/).filter(Boolean);
  const dataPatterns = ignored.filter((entry) => /(^|\/)data(?:\/|$)/.test(entry));

  assert.ok(
    dataPatterns.includes('/data') || dataPatterns.includes('data/'),
    'the root /data or data/ directory must be excluded from Docker build context',
  );
  assert.ok(
    dataPatterns.every((entry) => entry === '/data' || entry === 'data/'),
    'data ignore patterns must remain scoped to the Compose root data directory',
  );
  assert.ok(
    ignored.every((entry) => !/^server(?:\/|$)/.test(entry)),
    'server data-handling source must remain in the Docker build context',
  );
});
