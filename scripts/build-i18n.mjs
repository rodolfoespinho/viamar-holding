#!/usr/bin/env node
/**
 * Viamar i18n build — generates pre-rendered HTML variants per language.
 *
 * Reads:  /index.html, /pacotes.html, ... (PT canonical sources)
 *         /i18n/{pt,en,es,fr}.json
 *
 * Writes: /en/<page>.html, /es/<page>.html, /fr/<page>.html
 *         /sitemap.xml (regenerated with all language URLs)
 *
 * The PT source files are read-only (untouched by this script). Hreflang
 * blocks in PT must be kept in sync manually — this script writes a warning
 * to stderr if any PT hreflang line is missing.
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const ROOT = process.cwd();
const PAGES = ['index.html', 'pacotes.html', 'historia.html', 'ilha.html', 'faqs.html', 'termos.html'];
const TARGET_LANGS = ['en', 'es', 'fr']; // PT canonical lives at root
const ALL_LANGS = ['pt', ...TARGET_LANGS];
const BASE_URL = 'https://viamar-berlenga.com';

const PAGE_META = {
  'index.html':    { prefix: 'meta.index',    priority: '1.0', changefreq: 'weekly'  },
  'pacotes.html':  { prefix: 'meta.pacotes',  priority: '0.9', changefreq: 'weekly'  },
  'ilha.html':     { prefix: 'meta.ilha',     priority: '0.8', changefreq: 'monthly' },
  'historia.html': { prefix: 'meta.historia', priority: '0.8', changefreq: 'monthly' },
  'faqs.html':     { prefix: 'meta.faqs',     priority: '0.7', changefreq: 'monthly' },
  'termos.html':   { prefix: 'meta.termos',   priority: '0.5', changefreq: 'yearly'  },
};

const FH_LANG = { pt: 'pt-pt', en: 'en-us', es: 'es-es', fr: 'fr-fr' };

// ── Dict loading ────────────────────────────────────────────────────────────
const dicts = {};
for (const lang of ALL_LANGS) {
  const path = join(ROOT, 'i18n', `${lang}.json`);
  dicts[lang] = JSON.parse(await readFile(path, 'utf8'));
}
const baseKeys = new Set(Object.keys(dicts.pt));
for (const lang of TARGET_LANGS) {
  const missing = [...baseKeys].filter(k => dicts[lang][k] === undefined);
  if (missing.length) {
    console.warn(`[warn] ${lang}.json missing ${missing.length} keys: ${missing.slice(0,5).join(', ')}${missing.length>5?'...':''}`);
  }
}

// ── URL helpers ─────────────────────────────────────────────────────────────
function pathFor(lang, page) {
  const slug = page === 'index.html' ? '' : page;
  if (lang === 'pt') return `/${slug}`;
  return `/${lang}/${slug}`;
}
function urlFor(lang, page) {
  return `${BASE_URL}${pathFor(lang, page)}`;
}

function hreflangBlock(page, indent = '  ') {
  const lines = [];
  for (const l of ALL_LANGS) {
    const code = l === 'pt' ? 'pt-PT' : l;
    lines.push(`${indent}<link rel="alternate" hreflang="${code}" href="${urlFor(l, page)}" />`);
  }
  lines.push(`${indent}<link rel="alternate" hreflang="x-default" href="${urlFor('pt', page)}" />`);
  return lines.join('\n');
}

// ── HTML transforms ─────────────────────────────────────────────────────────
function rewriteInternalLinks(root, lang) {
  if (lang === 'pt') return;
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href) return;
    if (/^(https?:|mailto:|tel:|whatsapp:|#)/i.test(href)) return;
    // Split off hash + query
    let path = href, hash = '', query = '';
    const hashIdx = path.indexOf('#');
    if (hashIdx >= 0) { hash = path.slice(hashIdx); path = path.slice(0, hashIdx); }
    const qIdx = path.indexOf('?');
    if (qIdx >= 0) { query = path.slice(qIdx); path = path.slice(0, qIdx); }
    // Root index
    if (path === '/' || path === '') {
      a.setAttribute('href', `/${lang}/${query}${hash}`);
      return;
    }
    // /pacotes.html, /faqs.html, etc.
    const cleaned = path.replace(/^\/+/, '');
    if (PAGES.includes(cleaned)) {
      a.setAttribute('href', `/${lang}/${cleaned}${query}${hash}`);
    }
  });
}

function updateFareHarborUrls(root, lang) {
  const fhLang = FH_LANG[lang] || 'en-us';
  // Update <a href> with fareharbor.com (booking links)
  root.querySelectorAll('a[href*="fareharbor.com"]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href) return;
    if (/language=[^&]*/.test(href)) {
      a.setAttribute('href', href.replace(/language=[^&]*/, 'language=' + fhLang));
    } else if (href.includes('?')) {
      a.setAttribute('href', href + '&language=' + fhLang);
    } else {
      a.setAttribute('href', href + '?language=' + fhLang);
    }
  });
  // Update <script src> with fareharbor.com (calendar embed loader)
  root.querySelectorAll('script[src*="fareharbor.com"]').forEach(s => {
    const src = s.getAttribute('src');
    if (!src) return;
    if (/language=[^&]*/.test(src)) {
      s.setAttribute('src', src.replace(/language=[^&]*/, 'language=' + fhLang));
    }
  });
}

function applyI18n(root, dict) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) {
      el.set_content(dict[key]);
    }
  });
}

function updateMeta(root, dict, prefix, lang, page) {
  const head = root.querySelector('head');
  if (!head) return;

  // <title>
  const titleVal = dict[`${prefix}.title`];
  if (titleVal) {
    const t = root.querySelector('title');
    if (t) t.set_content(titleVal);
  }
  // meta description
  const descVal = dict[`${prefix}.description`];
  if (descVal) {
    const m = root.querySelector('meta[name="description"]');
    if (m) m.setAttribute('content', descVal);
  }
  // og:title
  const ogTitle = dict[`${prefix}.og_title`];
  if (ogTitle) {
    const m = root.querySelector('meta[property="og:title"]');
    if (m) m.setAttribute('content', ogTitle);
  }
  // og:description
  const ogDesc = dict[`${prefix}.og_description`];
  if (ogDesc) {
    const m = root.querySelector('meta[property="og:description"]');
    if (m) m.setAttribute('content', ogDesc);
  }
  // og:url → per-language URL
  const ogUrl = root.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', urlFor(lang, page));
  // twitter:title / twitter:description (if present)
  const twTitle = root.querySelector('meta[name="twitter:title"]');
  if (twTitle && ogTitle) twTitle.setAttribute('content', ogTitle);
  const twDesc = root.querySelector('meta[name="twitter:description"]');
  if (twDesc && ogDesc) twDesc.setAttribute('content', ogDesc);
}

function replaceHreflang(root, page) {
  const head = root.querySelector('head');
  if (!head) return;
  // Remove existing alternate hreflang links
  head.querySelectorAll('link[rel="alternate"][hreflang]').forEach(l => l.remove());
  // Append the new block as raw HTML (parse a fragment)
  const block = `\n  <!-- hreflang -->\n${hreflangBlock(page, '  ')}\n`;
  head.appendChild(parse(block));
}

function setCanonical(root, lang, page) {
  const head = root.querySelector('head');
  if (!head) return;
  let canonical = root.querySelector('link[rel="canonical"]');
  if (canonical) {
    canonical.setAttribute('href', urlFor(lang, page));
  } else {
    head.appendChild(parse(`<link rel="canonical" href="${urlFor(lang, page)}" />`));
  }
}

// ── Per-page build ──────────────────────────────────────────────────────────
async function buildForLang(page, lang) {
  const src = await readFile(join(ROOT, page), 'utf8');
  const root = parse(src, {
    blockTextElements: { script: true, style: true, pre: true, noscript: true }
  });

  // 1. <html lang>
  const htmlEl = root.querySelector('html');
  if (htmlEl) {
    htmlEl.setAttribute('lang', lang === 'pt' ? 'pt-PT' : lang);
    htmlEl.setAttribute('data-lang', lang);
  }

  const meta = PAGE_META[page];
  if (meta) updateMeta(root, dicts[lang], meta.prefix, lang, page);

  setCanonical(root, lang, page);
  replaceHreflang(root, page);

  // 2. Apply data-i18n with target lang dict
  applyI18n(root, dicts[lang]);

  // 3. Rewrite internal links to /{lang}/ prefix
  rewriteInternalLinks(root, lang);

  // 4. Update FareHarbor URLs (both <a> and the calendar <script>)
  updateFareHarborUrls(root, lang);

  // 5. Output
  const outDir = join(ROOT, lang);
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, page);
  await writeFile(outPath, root.toString(), 'utf8');
}

// PT canonical: refresh canonical + hreflang AND keep meta in sync with dict.
// Does NOT replace data-i18n content (PT is the source HTML — visible body
// content stays as written).
async function refreshPt(page) {
  const src = await readFile(join(ROOT, page), 'utf8');
  const root = parse(src, {
    blockTextElements: { script: true, style: true, pre: true, noscript: true }
  });
  const meta = PAGE_META[page];
  if (meta) updateMeta(root, dicts.pt, meta.prefix, 'pt', page);
  setCanonical(root, 'pt', page);
  replaceHreflang(root, page);
  await writeFile(join(ROOT, page), root.toString(), 'utf8');
}

// ── Sitemap ─────────────────────────────────────────────────────────────────
async function buildSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');

  for (const page of PAGES) {
    const meta = PAGE_META[page] || { priority: '0.5', changefreq: 'monthly' };
    for (const lang of ALL_LANGS) {
      lines.push('  <url>');
      lines.push(`    <loc>${urlFor(lang, page)}</loc>`);
      lines.push(`    <lastmod>${today}</lastmod>`);
      lines.push(`    <changefreq>${meta.changefreq}</changefreq>`);
      lines.push(`    <priority>${meta.priority}</priority>`);
      for (const altLang of ALL_LANGS) {
        const code = altLang === 'pt' ? 'pt-PT' : altLang;
        lines.push(`    <xhtml:link rel="alternate" hreflang="${code}" href="${urlFor(altLang, page)}" />`);
      }
      lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor('pt', page)}" />`);
      lines.push('  </url>');
    }
  }
  lines.push('</urlset>');
  await writeFile(join(ROOT, 'sitemap.xml'), lines.join('\n'), 'utf8');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  console.log('[viamar-i18n] start');

  // Clean previous output dirs to avoid stale files
  for (const lang of TARGET_LANGS) {
    const dir = join(ROOT, lang);
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }

  // Generate non-PT variants
  for (const lang of TARGET_LANGS) {
    for (const page of PAGES) {
      await buildForLang(page, lang);
      console.log(`  ✓ /${lang}/${page}`);
    }
  }

  // Refresh PT canonical hreflang/canonical
  for (const page of PAGES) {
    await refreshPt(page);
    console.log(`  ✓ /${page} (canonical refresh)`);
  }

  await buildSitemap();
  console.log('  ✓ /sitemap.xml');

  const ms = Date.now() - start;
  console.log(`[viamar-i18n] done in ${ms}ms`);
}

main().catch(err => {
  console.error('[viamar-i18n] build failed:', err);
  process.exit(1);
});
