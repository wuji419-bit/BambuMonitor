import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function jobBlock(workflow, name) {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = /^  [a-zA-Z][\w-]*:\s*$/m.exec(remainder);
  return remainder.slice(0, nextJob?.index ?? remainder.length);
}

test('test:nas includes the NAS release contract suite', async () => {
  const manifest = JSON.parse(await read('package.json'));

  assert.match(manifest.scripts['test:nas'], /scripts\/nas-release\.test\.mjs/);
});

test('Docker publish workflow has the required triggers, top-level permissions, and quality gate', async () => {
  const workflow = await read('.github/workflows/docker-publish.yml');
  const quality = jobBlock(workflow, 'quality');

  assert.match(workflow, /^name:\s*.+Docker.+$/mi);
  assert.match(workflow, /^on:\s*\n\s{2}workflow_dispatch:\s*\n\s{2}push:\s*\n\s{4}tags:\s*\n\s{6}-\s*["']?v\*["']?\s*$/m);
  assert.match(workflow, /^permissions:\s*\n\s{2}contents:\s*read\s*\n\s{2}packages:\s*write\s*\n\s{2}id-token:\s*write\s*$/m);
  assert.match(quality, /^\s{4}runs-on:\s*ubuntu-latest\s*$/m);
  assert.match(quality, /uses:\s*actions\/checkout@v4/);
  assert.match(quality, /uses:\s*actions\/setup-node@v4[\s\S]*node-version:\s*["']?22["']?[\s\S]*cache:\s*npm/);
  for (const command of ['npm ci', 'npm test', 'npm run test:nas', 'npm run lint', 'npm run build']) {
    assert.match(quality, new RegExp(`run:\\s*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`));
  }
});

test('amd64 smoke waits for quality, tests the freshly loaded image, and always cleans its resources', async () => {
  const workflow = await read('.github/workflows/docker-publish.yml');
  const smoke = jobBlock(workflow, 'smoke');

  assert.match(smoke, /^\s{4}needs:\s*quality\s*$/m);
  assert.match(smoke, /uses:\s*docker\/setup-buildx-action@v3/);
  assert.match(smoke, /uses:\s*docker\/build-push-action@v6/);
  assert.match(smoke, /platforms:\s*linux\/amd64/);
  assert.match(smoke, /load:\s*true/);
  assert.match(smoke, /push:\s*false/);
  assert.match(smoke, /tags:\s*bambu-monitor:nas-test/);
  assert.match(smoke, /run:\s*npm run docker:smoke/);
  assert.match(smoke, /DOCKER_SMOKE_IMAGE:\s*bambu-monitor:nas-test/);
  assert.match(smoke, /if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]*docker (?:container )?rm[^\n]*bambu-monitor-smoke[\s\S]*docker volume rm[^\n]*bambu-monitor-smoke-data/);
});

test('tag publishing waits for both gates and uses only the intended multi-arch GHCR tags', async () => {
  const workflow = await read('.github/workflows/docker-publish.yml');
  const publish = jobBlock(workflow, 'publish');

  assert.match(publish, /^\s{4}needs:\s*\[quality, smoke\]\s*$/m);
  assert.match(publish, /^\s{4}if:\s*startsWith\(github\.ref,\s*["']refs\/tags\/v["']\)\s*$/m);
  for (const action of [
    'actions/checkout@v4',
    'docker/setup-qemu-action@v3',
    'docker/setup-buildx-action@v3',
    'docker/login-action@v3',
    'docker/metadata-action@v5',
    'docker/build-push-action@v6',
  ]) {
    assert.match(publish, new RegExp(`uses:\\s*${action.replaceAll('/', '\\/')}`));
  }
  assert.match(publish, /registry:\s*ghcr\.io/);
  assert.match(publish, /images:\s*ghcr\.io\/wuji419-bit\/bambu-monitor/);
  assert.match(publish, /type=semver,pattern=\{\{version\}\}/);
  assert.match(publish, /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/);
  assert.doesNotMatch(publish, /type=semver,pattern=\{\{major\}\}(?:\s|$)/);
  assert.match(publish, /type=raw,value=latest,enable=\$\{\{\s*startsWith\(github\.ref,\s*["']refs\/tags\/v["']\)\s*\}\}/);
  assert.match(publish, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(publish, /push:\s*true/);
  assert.match(publish, /cache-from:\s*type=registry,ref=ghcr\.io\/wuji419-bit\/bambu-monitor:buildcache/);
  assert.match(publish, /cache-to:\s*type=registry,ref=ghcr\.io\/wuji419-bit\/bambu-monitor:buildcache,mode=max/);
  assert.match(publish, /sbom:\s*true/);
  assert.match(publish, /provenance:\s*true/);
});

test('NAS guide provides a complete Chinese deployment and lifecycle runbook', async () => {
  const guide = await read('docs/NAS_DOCKER.md');

  assert.doesNotMatch(guide, /\b(?:Quick Start|Troubleshooting|Security|Uninstall)\b/);
  for (const expected of [
    /Linux NAS/,
    /host network|host 网络/,
    /amd64/,
    /arm64/,
    /macOS Docker Desktop[^\n]*非正式|macOS[^\n]*不作为[^\n]*NAS/,
    /mkdir -p data/,
    /chown -R 1000:1000 data/,
    /compose\.yaml/,
    /docker compose up -d/,
    /http:\/\/NAS-IP:3080/,
    /docker compose logs -f/,
    /docker compose pull[\s\S]*docker compose up -d/,
    /docker compose (?:down|stop)/,
    /备份[\s\S]*\.\/data/,
    /完整重置[\s\S]*docker compose down[\s\S]*data[\s\S]*chown -R 1000:1000 data/,
  ]) {
    assert.match(guide, expected);
  }
});

test('NAS guide documents configuration, health behavior, and persistent encryption data', async () => {
  const guide = await read('docs/NAS_DOCKER.md');

  assert.match(guide, /ghcr\.io\/wuji419-bit\/bambu-monitor:latest/);
  for (const variable of ['PORT', 'DATA_DIR', 'TZ', 'TRUST_PROXY']) assert.match(guide, new RegExp(`\\b${variable}\\b`));
  assert.match(guide, /TRUST_PROXY[\s\S]*受信[^\n]*反向代理[\s\S]*X-Forwarded-Proto[\s\S]*[=：]\s*`?1`?/);
  assert.match(guide, /\/healthz/);
  assert.match(guide, /\/readyz/);
  assert.match(guide, /data[^\n]*不可写[\s\S]*\/readyz[^\n]*503[\s\S]*["'`]?code["'`]?[\s\S]*STORAGE_UNAVAILABLE/);
  assert.match(guide, /STORAGE_UNAVAILABLE[^\n]*(?:不包含|不会[^\n]*包含)[^\n]*(?:路径|原始错误)/);
  assert.match(guide, /storage-unavailable[^\n]*不会[^\n]*(?:路径|原始错误)/);
  assert.doesNotMatch(guide, /EACCES|EPERM/);
  assert.match(guide, /secret\.key[^\n]*(?:丢失|损坏)[\s\S]*session\.enc[^\n]*无法解密[\s\S]*重新登录/);
  assert.match(guide, /备份整个[^\n]*data/);
});

test('NAS guide states the network boundary, support channels, and AGPL obligations', async () => {
  const guide = await read('docs/NAS_DOCKER.md');

  assert.match(guide, /拓竹账号[^\n]*直接登录/);
  assert.match(guide, /云端状态[^\n]*(?:不要求|无需)[^\n]*IP/);
  assert.match(guide, /摄像头[^\n]*本地状态[^\n]*NAS[^\n]*访问[^\n]*打印机[^\n]*LAN|NAS[^\n]*访问[^\n]*打印机[^\n]*局域网/);
  assert.match(guide, /外部浏览器[^\n]*只[^\n]*NAS/);
  assert.match(guide, /绝不[^\n]*公网[^\n]*打印机[^\n]*(?:MQTT|摄像头)[\s\S]*(?:MQTT|摄像头)[^\n]*端口/);
  assert.match(guide, /HTTPS[^\n]*域名[^\n]*反向代理[^\n]*用户[^\n]*管理/);
  assert.match(guide, /安全/);
  assert.match(guide, /排错/);
  assert.match(guide, /卸载/);
  assert.match(guide, /526457346/);
  assert.match(guide, /https:\/\/github\.com\/wuji419-bit\/BambuMonitor/);
  assert.match(guide, /AGPLv3[\s\S]*网络[^\n]*(?:部署|服务)[\s\S]*源码/);
});

test('README puts the NAS quick start near the top without replacing desktop content', async () => {
  const readme = await read('README.md');
  const whyDesktop = readme.indexOf('## 为什么使用 BambuMonitor');
  const nasStart = readme.indexOf('## NAS / Docker 版');

  assert.ok(nasStart > 0 && nasStart < whyDesktop, 'NAS section must appear before the desktop feature overview');
  const nas = readme.slice(nasStart, whyDesktop);
  assert.match(nas, /一(?:个)?容器/);
  assert.match(nas, /mkdir -p [^\n]+/);
  assert.match(nas, /mkdir -p data/);
  assert.match(nas, /chown -R 1000:1000 data/);
  assert.match(nas, /docker compose up -d/);
  assert.match(nas, /ghcr\.io\/wuji419-bit\/bambu-monitor:latest/);
  assert.match(nas, /amd64/);
  assert.match(nas, /arm64/);
  assert.match(nas, /docs\/NAS_DOCKER\.md/);
  assert.match(nas, /https:\/\/github\.com\/wuji419-bit\/BambuMonitor/);
  assert.match(nas, /526457346/);
  assert.match(nas, /云端状态[^\n]*(?:不要求|无需)[^\n]*IP/);
  assert.match(nas, /摄像头[^\n]*NAS[^\n]*打印机[^\n]*(?:可达|局域网)/);
  assert.match(nas, /不支持[^\n]*公网[^\n]*打印机[^\n]*画面/);
  assert.match(nas, /AGPLv3[^\n]*网络服务[^\n]*修改版[^\n]*源码/);
  assert.match(readme, /## 下载安装/);
});
