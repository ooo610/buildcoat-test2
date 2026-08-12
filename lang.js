/* ══════════════════════════════════════════════════════════
   lang.js – simplified for static bilingual pages
   Each page now has its own real HTML content (index.html /
   index-ar.html, etc). This file no longer swaps text via JS.
   Its only job now:
   1) Remember which language the visitor is currently reading,
      so a later visit to the site root can send them to the
      right version automatically.
   2) Provide an optional redirectToPreferredLanguage() helper
      for a "smart" landing page, if you choose to use one.
══════════════════════════════════════════════════════════ */

(function () {
  const STORAGE_KEY = 'buildcoat_lang';

  // Detect which language this current page is (based on <html lang="">)
  const currentPageLang = document.documentElement.lang === 'ar' ? 'ar' : 'en';

  // Save whichever language the visitor is currently looking at,
  // so next time they land on the site root we can redirect them correctly.
  localStorage.setItem(STORAGE_KEY, currentPageLang);
})();

/**
 * Call this ONLY from a plain "entry" page (e.g. a root index.html that
 * you want to act as a smart redirector) BEFORE any visible content renders.
 * Not needed on pages that already have a fixed language, like index-ar.html
 * or index.html when both are real, separate pages users can link to directly.
 */
function redirectToPreferredLanguage(enPage, arPage) {
  const saved = localStorage.getItem('buildcoat_lang');
  if (saved) {
    window.location.replace(saved === 'ar' ? arPage : enPage);
    return;
  }
  const browserLang = navigator.language || navigator.userLanguage || '';
  const preferred = browserLang.toLowerCase().startsWith('ar') ? arPage : enPage;
  window.location.replace(preferred);
}
