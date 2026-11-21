import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

test('preview redirects to canonical document and every relative asset loads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fieldnote-preview-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'dashboard'));
  const page = '<!doctype html><link rel="stylesheet" href="./app.css"><script src="../data.js"></script><script type="module" src="./app.js"></script>';
  await writeFile(join(root, 'dashboard/index.html'), page);
  await writeFile(join(root, 'dashboard/app.css'), 'body { color: green; }');
  await writeFile(join(root, 'dashboard/app.js'), "import './engine.js';");
  await writeFile(join(root, 'dashboard/engine.js'), 'export const ready = true;');
  await writeFile(join(root, 'data.js'), 'window.DATA = {};');
  const port = await availablePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), root], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const readiness = once(child.stdout, 'data');
  const failure = once(child, 'exit').then(([code]) => { throw new Error(`Preview exited before ready: ${code}`); });
  await Promise.race([readiness, failure]);
  const origin = `http://127.0.0.1:${port}`;

  for (const path of ['/', '/dashboard', '/dashboard/']) {
    const redirect = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/dashboard/index.html');
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.url, origin + '/dashboard/index.html');
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:css|js))"/g)].map(match => new URL(match[1], response.url));
    assert.equal(assets.length, 3);
    for (const url of assets) {
      const asset = await fetch(url);
      assert.equal(asset.status, 200, `Failed relative asset ${url}`);
      assert.match(asset.headers.get('content-type'), url.pathname.endsWith('.css') ? /text\/css/ : /javascript/);
    }
    const module = await fetch(new URL('./engine.js', new URL('./app.js', response.url)));
    assert.equal(module.status, 200);
  }
  assert.equal((await fetch(origin + '/%2e%2e%2fprivate.json')).status, 403);
  assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
});
