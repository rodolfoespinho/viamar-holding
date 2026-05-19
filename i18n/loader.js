/**
 * Viamar i18n loader — handles client-side language switching for the
 * pre-rendered multilingual static site.
 *
 * URL structure:
 *   /                 → PT canonical
 *   /<page>.html      → PT canonical
 *   /<lang>/          → EN / ES / FR pre-rendered variant
 *   /<lang>/<page>.html
 *
 * Behaviour:
 *  - Initial language is determined by URL path prefix (most reliable).
 *  - On the PT canonical path with no user choice, if the browser language
 *    is unsupported (DE/NL/IT/etc.), the visitor is redirected ONCE to /en/.
 *  - The language switcher buttons navigate to the equivalent URL in the
 *    target language (not in-place content swap) — this gives stable URLs
 *    and proper SEO signal.
 *  - User choice is persisted in localStorage so a returning visitor
 *    lands on the variant they previously chose.
 *  - The loader still applies the dict at runtime (idempotent on
 *    pre-rendered pages — runs in <30ms, no FOUC).
 */
(function () {
  'use strict';

  var SUPPORTED = ['pt', 'en', 'es', 'fr'];
  var FALLBACK = 'en';
  var STORAGE_KEY = 'viamar_lang';
  var REDIRECT_GUARD = 'viamar_redirected';

  // Pages we recognise as canonical entry points
  var KNOWN_PAGES = ['index.html', 'pacotes.html', 'historia.html', 'ilha.html', 'faqs.html', 'termos.html'];

  function normalize(lang) {
    if (!lang) return null;
    var two = String(lang).toLowerCase().slice(0, 2);
    return SUPPORTED.indexOf(two) !== -1 ? two : null;
  }

  /**
   * Parse the current URL and return { lang, page, isCanonicalPt }.
   * For `/en/pacotes.html` → { lang:'en', page:'pacotes.html' }
   * For `/pacotes.html`    → { lang:'pt', page:'pacotes.html', isCanonicalPt:true }
   * For `/`                → { lang:'pt', page:'index.html', isCanonicalPt:true }
   * For `/en/`             → { lang:'en', page:'index.html' }
   */
  function parsePath() {
    var path = window.location.pathname || '/';
    // Strip leading slash
    var clean = path.replace(/^\/+/, '');
    var parts = clean.split('/');
    var first = parts[0] || '';
    if (SUPPORTED.indexOf(first) !== -1 && first !== 'pt') {
      // Lang-prefixed path
      var rest = parts.slice(1).filter(Boolean);
      var page = rest.length === 0 ? 'index.html' : rest[rest.length - 1];
      if (!/\.html$/i.test(page) && KNOWN_PAGES.indexOf(page) === -1) page = 'index.html';
      return { lang: first, page: page, isCanonicalPt: false };
    }
    // PT canonical path
    var page2 = (parts.length === 0 || parts[0] === '') ? 'index.html' : parts[parts.length - 1];
    if (!/\.html$/i.test(page2)) page2 = 'index.html';
    return { lang: 'pt', page: page2, isCanonicalPt: true };
  }

  function urlFor(lang, page) {
    var slug = page === 'index.html' ? '' : page;
    if (lang === 'pt') return '/' + slug;
    return '/' + lang + '/' + slug;
  }

  function detectBrowserLang() {
    var nav = navigator.language || (navigator.languages && navigator.languages[0]) || '';
    return normalize(nav);
  }

  function getStoredLang() {
    try { return normalize(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }

  function persist(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  }

  // ── Auto-redirect logic ───────────────────────────────────────────────────
  // Only triggers on first visit to PT canonical when browser is non-PT.
  // Once per session (sessionStorage guard) to avoid loops.
  function maybeAutoRedirect(parsed) {
    if (!parsed.isCanonicalPt) return false;
    // Skip if user explicitly chose a lang (?lang= or stored choice exists)
    var qsLang = null;
    try {
      qsLang = normalize(new URLSearchParams(window.location.search).get('lang'));
    } catch (e) {}
    if (qsLang) return false;
    if (getStoredLang()) return false;
    // One-shot guard for this session
    try {
      if (sessionStorage.getItem(REDIRECT_GUARD)) return false;
      sessionStorage.setItem(REDIRECT_GUARD, '1');
    } catch (e) {}
    var browserLang = detectBrowserLang();
    // If browser is PT, stay on canonical
    if (browserLang === 'pt') return false;
    // If browser is EN/ES/FR, redirect to matching variant
    // If browser is unsupported (DE/NL/IT/…), redirect to /en/ per product decision
    var target = browserLang || FALLBACK;
    if (target === 'pt') return false;
    var newPath = urlFor(target, parsed.page) + window.location.search + window.location.hash;
    window.location.replace(newPath);
    return true;
  }

  // ── Dict fetch + apply ────────────────────────────────────────────────────
  var dictCache = {};
  function fetchDict(lang) {
    if (dictCache[lang]) return Promise.resolve(dictCache[lang]);
    return fetch('/i18n/' + lang + '.json', { cache: 'default' })
      .then(function (r) {
        if (!r.ok) throw new Error('i18n fetch failed: ' + lang);
        return r.json();
      })
      .then(function (data) { dictCache[lang] = data; return data; });
  }

  function applyDict(dict, lang) {
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.lang = lang === 'pt' ? 'pt-PT' : lang;

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (key && dict[key] !== undefined) {
        el.innerHTML = dict[key];
      }
    });

    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      var spec = el.getAttribute('data-i18n-attr');
      spec.split(',').forEach(function (pair) {
        var parts = pair.split(':');
        if (parts.length !== 2) return;
        var key = parts[0].trim();
        var attr = parts[1].trim();
        if (key && attr && dict[key] !== undefined) {
          el.setAttribute(attr, dict[key]);
        }
      });
    });

    // Lang-prefix every relative internal anchor that points to a known page.
    // Dict values may include hardcoded /termos.html links — rewrite to
    // /<lang>/termos.html so we don't bounce the user back to PT.
    if (lang !== 'pt') {
      var pagesRe = /^\/?(index|pacotes|historia|ilha|faqs|termos)\.html(\?|#|$)/;
      var alreadyPrefixedRe = new RegExp('^/(' + ['en','es','fr'].join('|') + ')/');
      document.querySelectorAll('a[href]').forEach(function (a) {
        var href = a.getAttribute('href');
        if (!href) return;
        if (/^(https?:|mailto:|tel:|whatsapp:|sms:|#)/i.test(href)) return;
        if (alreadyPrefixedRe.test(href)) return;
        if (href === '/' || href === '') {
          a.setAttribute('href', '/' + lang + '/');
          return;
        }
        var stripped = href.replace(/^\/+/, '');
        if (pagesRe.test(stripped)) {
          a.setAttribute('href', '/' + lang + '/' + stripped);
        }
      });
    }

    document.querySelectorAll('[data-lang-switch]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-lang-switch') === lang);
    });
    var lbl = document.getElementById('langDropLabel');
    if (lbl) lbl.textContent = lang.toUpperCase();

    window.viamarLang = lang;
    window.viamarDict = dict;
    document.dispatchEvent(new CustomEvent('viamar:lang-applied', { detail: { lang: lang } }));
  }

  // ── Language switcher ─────────────────────────────────────────────────────
  // Navigates to the equivalent URL in the target language (NOT in-place swap).
  function switchTo(targetLang) {
    var lang = normalize(targetLang) || FALLBACK;
    persist(lang);
    var parsed = parsePath();
    if (parsed.lang === lang) return; // already there
    var newUrl = urlFor(lang, parsed.page) + window.location.search + window.location.hash;
    window.location.href = newUrl;
  }

  function wireSwitchers(root) {
    (root || document).querySelectorAll('[data-lang-switch]').forEach(function (btn) {
      if (btn.__viamarWired) return;
      btn.__viamarWired = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        switchTo(btn.getAttribute('data-lang-switch'));
      });
    });
  }
  window.viamarWireLangSwitchers = wireSwitchers;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wireSwitchers(); });
  } else {
    wireSwitchers();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  var parsed = parsePath();
  if (maybeAutoRedirect(parsed)) return; // stop boot, we're redirecting

  // The page is already pre-rendered for `parsed.lang`. We still fetch the
  // dict so dynamic renders (loadProducts, etc.) work and viamar:lang-applied
  // fires for listeners. Applying it is idempotent on pre-rendered HTML.
  persist(parsed.lang);
  fetchDict(parsed.lang)
    .then(function (dict) { applyDict(dict, parsed.lang); })
    .catch(function (err) {
      console.error('[i18n] dict load failed', err);
      if (parsed.lang !== FALLBACK) {
        fetchDict(FALLBACK).then(function (d) { applyDict(d, FALLBACK); });
      }
    });

  // Public API
  window.setViamarLang = switchTo;
  window.getViamarLang = function () { return window.viamarLang || parsed.lang; };
})();
