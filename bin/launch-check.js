#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return 'Usage: launch-check <config.json>\n';
}

function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#[0-9]+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    const key = entity.toLowerCase();
    if (named[key]) return named[key];
    const code = key[2] === 'x' ? Number.parseInt(key.slice(3, -1), 16) : Number.parseInt(key.slice(2, -1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a JSON object');
  let base;
  try { base = new URL(config.baseUrl); } catch { throw new Error('baseUrl must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('baseUrl must be an absolute HTTP(S) URL');
  if (!Array.isArray(config.pages) || config.pages.length === 0) throw new Error('pages must be a non-empty array');
  if (config.sitemapPath !== undefined && (typeof config.sitemapPath !== 'string' || !config.sitemapPath.startsWith('/'))) throw new Error('sitemapPath must be an absolute site path');
  const seen = new Set();
  for (const page of config.pages) {
    if (!page || typeof page.path !== 'string' || !page.path.startsWith('/') || page.path.startsWith('//')) throw new Error('each page must have an absolute site path');
    if (seen.has(page.path)) throw new Error(`duplicate page path: ${page.path}`);
    seen.add(page.path);
    if (typeof page.lastmod !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(page.lastmod) || Number.isNaN(Date.parse(page.lastmod))) throw new Error(`page ${page.path} needs a valid lastmod ISO date`);
    if (typeof page.shareImage !== 'string' || !page.shareImage.startsWith('/') || page.shareImage.startsWith('//')) throw new Error(`page ${page.path} needs an absolute shareImage path`);
  }
  if (typeof config.indexNowKey !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(config.indexNowKey)) throw new Error('indexNowKey must contain 8-128 letters, digits, or hyphens');
  if (typeof config.analyticsId !== 'string' || !config.analyticsId.trim()) throw new Error('analyticsId must be a non-empty string');
  return config;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function parseSitemap(xml) {
  const entries = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].flatMap(([, body]) => {
    const loc = body.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1];
    if (!loc) return [];
    const lastmod = body.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1] ?? '';
    return [[decodeXml(loc.trim()), decodeXml(lastmod.trim())]];
  });
  return entries;
}

function navigationLinks(html) {
  const links = [];
  const containerPattern = /<(nav|footer)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const [, , content] of html.matchAll(containerPattern)) {
    for (const [, attrs] of content.matchAll(/<a\b([^>]*)>/gi)) {
      const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (href) links.push(href);
    }
  }
  return links;
}

async function check(config) {
  const base = new URL(config.baseUrl);
  const checks = [];
  const sitemap = await fetchText(new URL(config.sitemapPath ?? '/sitemap.xml', base));
  const entries = parseSitemap(sitemap);
  const found = new Map(entries);
  checks.push({ check: 'sitemap parse', pass: entries.length > 0, detail: entries.length ? undefined : 'no sitemap URL entries found' });
  checks.push({ check: 'sitemap uniqueness', pass: found.size === entries.length, detail: found.size === entries.length ? undefined : 'duplicate URL entries found' });
  for (const [url, lastmod] of found) {
    if (lastmod && Number.isNaN(Date.parse(lastmod))) checks.push({ check: 'sitemap lastmod format', page: url, pass: false, detail: `invalid date: ${lastmod}` });
  }

  const pages = new Map();
  for (const page of config.pages) pages.set(page.path, await fetchText(new URL(page.path, base)));
  const homeLinks = pages.has('/') ? navigationLinks(pages.get('/')) : [];

  for (const page of config.pages) {
    const expectedUrl = new URL(page.path, base).href;
    const actualLastmod = found.get(expectedUrl);
    checks.push({ check: 'sitemap membership', page: page.path, pass: found.has(expectedUrl), detail: found.has(expectedUrl) ? undefined : 'missing from sitemap' });
    checks.push({ check: 'sitemap lastmod', page: page.path, pass: actualLastmod === page.lastmod, detail: actualLastmod === page.lastmod ? undefined : `expected ${page.lastmod}, got ${actualLastmod || '(missing)'}` });
    checks.push({ check: 'analytics tag', page: page.path, pass: pages.get(page.path).includes(config.analyticsId), detail: pages.get(page.path).includes(config.analyticsId) ? undefined : `analytics ID ${config.analyticsId} not found` });
    const pageLinks = navigationLinks(pages.get(page.path));
    const hasHomeLink = page.path === '/' || homeLinks.some(href => new URL(href, base).href === expectedUrl);
    const hasNavigationLink = pageLinks.some(href => new URL(href, base).href === expectedUrl);
    checks.push({ check: 'links from nav, footer and home', page: page.path, pass: hasHomeLink || hasNavigationLink, detail: page.path === '/' ? 'home page is the navigation root' : hasHomeLink ? 'linked from home' : hasNavigationLink ? 'linked from navigation/footer' : 'not linked from home, navigation, or footer' });

    const html = pages.get(page.path);
    const imageTag = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag).some(tag => /(?:property|name)=["'](?:og:image|twitter:image)["']/i.test(tag) && new RegExp(`content=["'][^"']*${escapeRegExp(page.shareImage)}[^"']*["']`, 'i').test(tag));
    checks.push({ check: 'share image metadata', page: page.path, pass: imageTag, detail: imageTag ? undefined : `og:image or twitter:image does not reference ${page.shareImage}` });

    try {
      const response = await fetch(new URL(page.shareImage, base), { method: 'HEAD', redirect: 'follow' });
      const imageOk = response.ok && /^image\//i.test(response.headers.get('content-type') ?? '');
      checks.push({ check: 'share image asset', page: page.path, pass: imageOk, detail: imageOk ? undefined : `HTTP ${response.status}; content-type ${response.headers.get('content-type') ?? '(missing)'}` });
    } catch (error) {
      checks.push({ check: 'share image asset', page: page.path, pass: false, detail: error.message });
    }
  }

  for (const url of found.keys()) {
    if (![...config.pages].some(page => new URL(page.path, base).href === url)) checks.push({ check: 'sitemap membership', page: url, pass: false, detail: 'unexpected URL in sitemap' });
  }

  const keyUrl = new URL(`/${config.indexNowKey}.txt`, base);
  const servedKey = (await fetchText(keyUrl)).trim();
  checks.push({ check: 'IndexNow key', pass: servedKey === config.indexNowKey, detail: servedKey === config.indexNowKey ? undefined : 'key file content does not match configured key' });
  return checks;
}

async function main(args) {
  if (args.length !== 1 || args[0] === '--help') {
    process.stdout.write(usage());
    process.exitCode = args.length === 1 ? 0 : 2;
    return;
  }
  try {
    const raw = await readFile(path.resolve(args[0]), 'utf8');
    const results = await check(validateConfig(JSON.parse(raw)));
    for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.check}${result.page ? ` ${result.page}` : ''}${result.detail ? `: ${result.detail}` : ''}`);
    const failed = results.filter(result => !result.pass).length;
    console.log(`${results.length - failed}/${results.length} checks passed`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`launch-check: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main(process.argv.slice(2));

export { check, parseSitemap, validateConfig };
