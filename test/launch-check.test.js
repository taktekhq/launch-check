import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, parseSitemap, validateConfig } from '../bin/launch-check.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const valid = {
  baseUrl: 'https://example.com',
  indexNowKey: '0123456789abcdef',
  analyticsId: 'G-EXAMPLE1234',
  pages: [{ path: '/', lastmod: '2026-01-15', shareImage: '/share.jpg' }]
};

function serve(handler) {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
  }));
}

test('accepts valid launch config', () => {
  assert.equal(validateConfig(valid), valid);
});

test('rejects duplicate page paths', () => {
  assert.throws(() => validateConfig({ ...valid, pages: [...valid.pages, valid.pages[0]] }), /duplicate page path/);
});

test('rejects invalid lastmod dates', () => {
  assert.throws(() => validateConfig({ ...valid, pages: [{ ...valid.pages[0], lastmod: 'not-a-date' }] }), /valid lastmod/);
});

test('rejects malformed IndexNow keys', () => {
  assert.throws(() => validateConfig({ ...valid, indexNowKey: 'has spaces' }), /indexNowKey/);
});

test('requires a share image per page', () => {
  assert.throws(() => validateConfig({ ...valid, pages: [{ path: '/', lastmod: '2026-01-15' }] }), /shareImage/);
});

test('parses sitemap entries and decodes XML entities', () => {
  assert.deepEqual(parseSitemap('<urlset><url><loc>https://example.com/a&amp;b</loc><lastmod>2026-01-15</lastmod></url></urlset>'), [['https://example.com/a&b', '2026-01-15']]);
});

test('checks sitemap, key, analytics, navigation and each share image', async t => {
  let baseUrl;
  const { server, baseUrl: url } = await serve((request, response) => {
    if (request.url === '/sitemap.xml') {
      response.end(`<urlset><url><loc>${baseUrl}/</loc><lastmod>2026-01-15</lastmod></url><url><loc>${baseUrl}/about</loc><lastmod>2026-01-16</lastmod></url></urlset>`);
    } else if (request.url === '/0123456789abcdef.txt') response.end('0123456789abcdef');
    else if (request.url === '/share.jpg') {
      response.setHeader('content-type', 'image/jpeg');
      response.end();
    } else if (request.url === '/') response.end('<html><head><script>G-EXAMPLE1234</script><meta property="og:image" content="/share.jpg"></head><body><nav><a href="/about">About</a></nav></body></html>');
    else if (request.url === '/about') response.end('<html><head><script>G-EXAMPLE1234</script><meta property="og:image" content="/share.jpg"></head><body><footer><a href="/about">About</a></footer></body></html>');
    else { response.statusCode = 404; response.end('missing'); }
  });
  baseUrl = url;
  t.after(() => server.close());
  const results = await check({
    baseUrl,
    indexNowKey: '0123456789abcdef',
    analyticsId: 'G-EXAMPLE1234',
    pages: [
      { path: '/', lastmod: '2026-01-15', shareImage: '/share.jpg' },
      { path: '/about', lastmod: '2026-01-16', shareImage: '/share.jpg' }
    ]
  });
  assert.equal(results.every(result => result.pass), true, JSON.stringify(results));
});

test('reports missing pages, lastmod mismatch, bad key and missing image metadata', async t => {
  let baseUrl;
  const { server, baseUrl: url } = await serve((request, response) => {
    if (request.url === '/sitemap.xml') response.end(`<urlset><url><loc>${baseUrl}/</loc><lastmod>2026-01-14</lastmod></url></urlset>`);
    else if (request.url === '/0123456789abcdef.txt') response.end('wrong');
    else if (request.url === '/share.jpg') { response.setHeader('content-type', 'image/jpeg'); response.end(); }
    else response.end('<html><head><script>G-EXAMPLE1234</script></head><body><footer><a href="/">Home</a></footer></body></html>');
  });
  baseUrl = url;
  t.after(() => server.close());
  const results = await check({
    baseUrl,
    indexNowKey: '0123456789abcdef',
    analyticsId: 'G-EXAMPLE1234',
    pages: [
      { path: '/', lastmod: '2026-01-15', shareImage: '/share.jpg' },
      { path: '/missing', lastmod: '2026-01-16', shareImage: '/share.jpg' }
    ]
  });
  assert.ok(results.some(result => result.check === 'sitemap lastmod' && !result.pass));
  assert.ok(results.some(result => result.check === 'sitemap membership' && result.page === '/missing' && !result.pass));
  assert.ok(results.some(result => result.check === 'IndexNow key' && !result.pass));
  assert.ok(results.some(result => result.check === 'share image metadata' && result.page === '/' && !result.pass));
});

test('CLI returns usage error for missing config and rejects invalid config', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = path.join(root, 'bin', 'launch-check.js');
  const { execFile } = await import('node:child_process');
  const run = args => new Promise(resolve => execFile(process.execPath, [cli, ...args], { cwd: root }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal((await run([])).code, 2);
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, '{"baseUrl":"not-url"}');
  const invalid = await run([configPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /baseUrl/);
});
