/**
 * reader.js — Content Script (Slice 3)
 *
 * Injected on-demand by the service worker via chrome.scripting.executeScript.
 * Uses Readability.js (also injected just before this script) to extract the
 * readable article content from the current page.
 *
 * Returns via chrome.runtime.sendMessage:
 *   { success: true,  title, byline, content, excerpt, length, url }
 *   { success: false, error: string }
 *
 * Edge cases handled:
 *   3.1 SPA not yet rendered   → content too short, caller retries
 *   3.2 Login/paywall page     → short content flagged with `likelyPaywall`
 *   3.4 No readable content    → success:false with clear reason
 *   3.6 Residual HTML tags     → textContent used, not innerHTML
 */

(function extractArticle() {
  try {
    // Readability is injected as a separate file just before this script runs.
    // In the content-script context `module` is undefined, so Readability is global.
    if (typeof Readability === "undefined") {
      chrome.runtime.sendMessage({
        type:    "reader-result",
        success: false,
        error:   "Readability library not available.",
      });
      return;
    }

    // Clone the document so Readability's DOM mutations don't affect the live page
    const docClone = document.cloneNode(true);
    const reader   = new Readability(docClone, {
      // Keep images out of textContent — we only want readable text
      keepClasses: false,
    });

    const article = reader.parse();

    if (!article || !article.textContent?.trim()) {
      chrome.runtime.sendMessage({
        type:    "reader-result",
        success: false,
        error:   "NO_CONTENT: No readable article found on this page.",
        url:     location.href,
      });
      return;
    }

    // Use plain textContent — strips residual HTML tags (edge case 3.6)
    const plainText = article.textContent.trim();

    // Flag very short extractions so the SW can warn the user (edge cases 3.1, 3.2)
    const likelyPaywall = plainText.length < 300;

    chrome.runtime.sendMessage({
      type:         "reader-result",
      success:      true,
      title:        article.title        ?? document.title ?? "",
      byline:       article.byline       ?? "",
      excerpt:      article.excerpt      ?? "",
      content:      plainText,
      length:       plainText.length,
      url:          location.href,
      likelyPaywall,
    });

  } catch (err) {
    chrome.runtime.sendMessage({
      type:    "reader-result",
      success: false,
      error:   `EXTRACT_ERROR: ${err.message}`,
      url:     location.href,
    });
  }
})();
