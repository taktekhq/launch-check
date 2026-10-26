# launch-check

`launch-check` is a small, deterministic Node.js CLI for checking whether a static website launch is represented consistently by its sitemap, page templates, IndexNow key, analytics tag and social share images. It performs read-only HTTP requests; it does not submit URLs or change site configuration.

## Requirements

- Node.js 20 or newer
- A public or locally reachable HTTP(S) website

## Install and run

```sh
npm install
npm test
node bin/launch-check.js launch-check.json
```

Or link the package globally to use `launch-check launch-check.json`.

Create `launch-check.json` (do not commit real site secrets):

```json
{
  "baseUrl": "https://example.com",
  "sitemapPath": "/sitemap.xml",
  "indexNowKey": "0123456789abcdef0123456789abcdef",
  "analyticsId": "G-EXAMPLE1234",
  "pages": [
    {
      "path": "/",
      "lastmod": "2026-01-15",
      "shareImage": "/images/home-social.jpg"
    },
    {
      "path": "/about/",
      "lastmod": "2026-01-15",
      "shareImage": "/images/about-social.jpg"
    }
  ]
}
```

`pages` is the expected launch inventory. Each path must appear in the sitemap with an exactly matching `lastmod`; unexpected sitemap URLs are reported too. The IndexNow key is checked by requesting `/<indexNowKey>.txt` and comparing its body with the configured key. Every listed page must contain the configured analytics ID, have discoverable links labelled or located as navigation/footer/home links, and serve its own `shareImage` with an image content type. The share-image check uses `HEAD`; the site must support it.

The links test uses markup heuristics: links whose href or text contains `nav`, `footer`, or `home`, plus `/`, are treated as candidates. It does not replace accessibility, crawl, or human review. All output is printed as `PASS`/`FAIL`; invalid configuration exits 1, usage errors exit 2, and any failed check exits 1.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | Site origin, for example `https://example.com` |
| `sitemapPath` | no | Sitemap URL path; defaults to `/sitemap.xml` |
| `indexNowKey` | yes | 8–128 alphanumeric/hyphen characters, expected key-file contents |
| `analyticsId` | yes | Non-empty analytics identifier expected in page HTML |
| `pages` | yes | Non-empty expected page inventory; each entry has `path`, `lastmod`, `shareImage` |

## CI

Run `node bin/launch-check.js launch-check.json` as a CI step after publishing a preview/staging site. Keep the config in CI secrets or generate it during the workflow when it contains deployment-specific data. The command exits non-zero if a check fails.

## License

MIT. See [LICENSE](LICENSE).
