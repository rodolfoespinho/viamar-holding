/**
 * Viamar i18n loader — single source of truth for client-side translations.
 *
 * Detection order: ?lang= URL param → localStorage.viamar_lang → navigator.language → 'en' fallback.
 * Persists user choice to localStorage. Exposes window.viamarLang and window.setViamarLang(lang).
 * Emits `viamar:lang-applied` CustomEvent on document after each apply.
 */
(function () {
  'use strict';

  var SUPPORTED = ['pt', 'en', 'es', 'fr'];
  var FALLBACK = 'en';
  var STORAGE_KEY = 'viamar_lang';

  function normalize(lang) {
    if (!lang) return null;
    var two = String(lang).toLowerCase().slice(0, 2);
    return SUPPORTED.indexOf(two) !== -1 ? two : null;
  }

  function detect() {
    try {
      var qs = new URLSearchParams(window.location.search).get('lang');
      var fromUrl = normalize(qs);
      if (fromUrl) return { lang: fromUrl, persist: true };
    } catch (e) {}
    try {
      var stored = normalize(localStorage.getItem(STORAGE_KEY));
      if (stored) return { lang: stored, persist: false };
    } catch (e) {}
    var fromBrowser = normalize(navigator.language || (navigator.languages && navigator.languages[0]));
    if (fromBrowser) return { lang: fromBrowser, persist: false };
    return { lang: FALLBACK, persist: false };
  }

  function persist(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  }

  var dictCache = {};
  function fetchDict(lang) {
    if (dictCache[lang]) return Promise.resolve(dictCache[lang]);
    return fetch('/i18n/' + lang + '.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('i18n fetch failed: ' + lang);
        return r.json();
      })
      .then(function (data) {
        dictCache[lang] = data;
        return data;
      });
  }

  function applyDict(dict, lang) {
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.lang = lang === 'pt' ? 'pt-PT' : lang;

    // Text content via [data-i18n="key"]
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (key && dict[key] !== undefined) {
        el.innerHTML = dict[key];
      }
    });

    // Attribute translation: [data-i18n-attr="key:attribute,key2:attribute2"]
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

    // Lang switcher button visual state
    document.querySelectorAll('[data-lang-switch]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-lang-switch') === lang);
    });
    var lbl = document.getElementById('langDropLabel');
    if (lbl) lbl.textContent = lang.toUpperCase();

    window.viamarLang = lang;
    window.viamarDict = dict;
    document.dispatchEvent(new CustomEvent('viamar:lang-applied', { detail: { lang: lang } }));
  }

  function setLang(lang, opts) {
    var n = normalize(lang) || FALLBACK;
    return fetchDict(n).then(function (dict) {
      applyDict(dict, n);
      if (!opts || opts.persist !== false) persist(n);
    }).catch(function (err) {
      console.error('[i18n] failed to load', n, err);
      if (n !== FALLBACK) return setLang(FALLBACK, { persist: false });
    });
  }

  // Boot
  var initial = detect();
  setLang(initial.lang, { persist: initial.persist });

  // Public API
  window.setViamarLang = function (lang) { return setLang(lang, { persist: true }); };
  window.getViamarLang = function () { return window.viamarLang || initial.lang; };

  // Wire up any [data-lang-switch] buttons that exist at boot
  function wireSwitchers(root) {
    (root || document).querySelectorAll('[data-lang-switch]').forEach(function (btn) {
      if (btn.__viamarWired) return;
      btn.__viamarWired = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var target = btn.getAttribute('data-lang-switch');
        window.setViamarLang(target);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wireSwitchers(); });
  } else {
    wireSwitchers();
  }

  // Re-wire if pages inject more switchers dynamically (e.g., mobile menus)
  window.viamarWireLangSwitchers = wireSwitchers;
})();
