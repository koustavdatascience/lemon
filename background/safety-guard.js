/**
 * safety-guard.js — Slice 16
 *
 * Deterministic safety checks for every path that accesses the DOM or
 * sends page content to an external AI provider. The AI model cannot
 * override these rules — they run in code before any API call.
 *
 * Public API:
 *   SafetyGuard.checkPage(url)          → { blocked, reason }
 *   SafetyGuard.checkPrivacy(url)       → { blocked, reason }
 *   SafetyGuard.checkField(element)     → { blocked, reason }
 *   SafetyGuard.checkAction(action)     → { blocked, reason, needsConfirm }
 *
 * All functions are synchronous and pure — no async, no side effects.
 *
 * Edge cases handled:
 *   16.1 Incomplete domain regex          → curated list + broad patterns
 *   16.2 Payment iframe after initial check → caller must re-run checkField
 *                                            per element at execute time
 *   16.3 OTP field with type="text"       → heuristic: name/id/placeholder/
 *                                            autocomplete keywords
 *   16.4 Confirm-modal cancel loops       → needsConfirm flag; caller calls skip()
 *   16.5 Stop races actor                 → handled by _state.stopping flag
 *                                            in agent-engine (not this module)
 *   16.6 URL changes to sensitive domain  → called again by _onTabUpdated
 *   16.8 Aggressive checkPrivacy          → distinguish portals vs. news
 */

// ─── Domain / URL pattern lists ───────────────────────────────────────────────

/**
 * Patterns for BLOCKING_PAGE — agent must not act on these pages.
 * Covers banking, payment, crypto, and UPI services.
 * Tests against the full URL (lowercased).
 */
const BLOCK_PAGE_PATTERNS = [
  // Banking / financial
  /bank/i,
  /credit.?union/i,
  /netbanking/i,
  /onlinebanking/i,
  /ibanking/i,
  /mbanking/i,
  // Payment / checkout
  /pay(?:ment|pal|oneer|tm|u|here|flow)?\.(?:com|in|io)/i,
  /checkout/i,
  /stripe\.com/i,
  /razorpay\.com/i,
  /paytm\.com/i,
  /phonepe\.com/i,
  /gpay\.com/i,
  /bhim/i,
  /upi/i,
  /neft|rtgs|imps/i,
  // Crypto
  /coinbase\.com/i,
  /binance\.com/i,
  /crypto\.com/i,
  /metamask/i,
  // Well-known bank TLDs
  /\.bank\b/i,
  // Generic purchase flows
  /\/cart\b/i,
  /\/checkout\b/i,
  /\/order\/confirm/i,
  /\/payment/i,
];

/**
 * Patterns for PRIVACY — content must NOT be sent to external AI.
 * Covers webmail, medical portals, government, and tax services.
 * Tests against the full URL (lowercased).
 *
 * Edge case 16.8: We block authenticated portals, NOT public news/information sites.
 * A healthcare news article on webmd.com/news is fine; a patient portal is not.
 * Heuristics: presence of /portal/, /inbox/, /patient/, /secure/, or /account/ paths
 * combined with domain patterns distinguishes portals from public content.
 */
const PRIVACY_DOMAIN_PATTERNS = [
  // Webmail
  /mail\.google\.com/i,
  /outlook\.live\.com/i,
  /outlook\.office\.com/i,
  /mail\.yahoo\.com/i,
  /proton\.me/i,
  /protonmail\.com/i,
  // Medical / health portals (not public news sites)
  /mychart\./i,
  /patient\./i,
  /\/patient-portal/i,
  /\/myhealth/i,
  /\/secure-message/i,
  // Government authenticated portals
  /\.gov\.in\/.*dashboard/i,
  /incometax\.gov\.in/i,
  /efiling\.income/i,
  /gst\.gov\.in/i,
  /epfindia\.gov\.in/i,
  // Generic authenticated patterns (path-based — not domain-only)
  /\/secure\/inbox/i,
  /\/webmail/i,
];

// ─── Field sensitivity patterns ───────────────────────────────────────────────

/**
 * Regex patterns matched against an element's type, name, id, placeholder,
 * and autocomplete attributes to detect sensitive fields.
 */
const SENSITIVE_FIELD_PATTERNS = {
  password: [
    { attr: "type",         re: /^password$/i },
  ],
  otp: [
    // Edge case 16.3: OTP fields often use type="text" or type="number"
    { attr: "autocomplete", re: /one-time-code/i },
    { attr: "name",         re: /\botp\b|one.?time|verify.?code|auth.?code|verification/i },
    { attr: "id",           re: /\botp\b|one.?time|verify.?code|auth.?code|verification/i },
    { attr: "placeholder",  re: /\botp\b|one.?time|verification code|auth.?code/i },
    { attr: "aria-label",   re: /\botp\b|one.?time|verification code/i },
  ],
  cardNumber: [
    { attr: "autocomplete", re: /cc-number|cardnumber|card-number/i },
    { attr: "name",         re: /card.?number|cc.?num|cardno/i },
    { attr: "id",           re: /card.?number|cc.?num|cardno/i },
    { attr: "placeholder",  re: /card number|card no\b/i },
  ],
  cvv: [
    { attr: "autocomplete", re: /cc-csc|cvc|cvv/i },
    { attr: "name",         re: /\bcvv\b|\bcvc\b|\bcsc\b/i },
    { attr: "id",           re: /\bcvv\b|\bcvc\b|\bcsc\b/i },
    { attr: "placeholder",  re: /\bcvv\b|\bcvc\b|\bcsc\b/i },
  ],
  pin: [
    { attr: "autocomplete", re: /current-password/i },
    { attr: "name",         re: /\bpin\b/i },
    { attr: "id",           re: /\bpin\b/i },
    { attr: "placeholder",  re: /\bpin\b/i },
  ],
};

/**
 * Button / action labels that require an extra confirmation step before executing.
 * The agent should pause and prompt the user with a modal rather than proceeding.
 * Edge case 16.4: if user declines, the caller must call skip(), not tick().
 */
const CONFIRM_ACTION_PATTERNS = [
  /\bsubmit\b/i,
  /\bpay\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bcheckout\b/i,
  /\bplace order\b/i,
  /\bconfirm order\b/i,
  /\bsend\b/i,          // "Send" in forms / messaging (financial contexts)
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdeactivate\b/i,
  /\bclose account\b/i,
];

// ─── Public API ───────────────────────────────────────────────────────────────

export const SafetyGuard = {

  /**
   * Block the agent from acting on banking, payment, or crypto pages.
   *
   * @param {string} url
   * @returns {{ blocked: boolean, reason: string }}
   */
  checkPage(url) {
    if (!url) return { blocked: false, reason: "" };
    for (const re of BLOCK_PAGE_PATTERNS) {
      if (re.test(url)) {
        return {
          blocked: true,
          reason:  `🛡️ Lemon does not act on banking, payment, or financial pages for your safety. URL pattern matched: ${re.source}`,
        };
      }
    }
    return { blocked: false, reason: "" };
  },

  /**
   * Prevent page content from being sent to external AI on privacy-sensitive pages.
   * Called before extractArticle / streamChat in summarise, page-chat, screenshot-ask.
   *
   * @param {string} url
   * @returns {{ blocked: boolean, reason: string }}
   */
  checkPrivacy(url) {
    if (!url) return { blocked: false, reason: "" };
    for (const re of PRIVACY_DOMAIN_PATTERNS) {
      if (re.test(url)) {
        return {
          blocked: true,
          reason:  `🔒 This page looks like a private portal (webmail, medical, or tax). Lemon won't read it to protect your privacy.`,
        };
      }
    }
    return { blocked: false, reason: "" };
  },

  /**
   * Block the actor from typing into password, OTP, card-number, CVV, or PIN fields.
   * The element object is the action-map entry from scanner.js:
   *   { type, label, placeholder, name?, id?, autocomplete?, sensitive? }
   *
   * @param {object|null} element  — from the action map, or null
   * @returns {{ blocked: boolean, reason: string }}
   */
  checkField(element) {
    if (!element) return { blocked: false, reason: "" };

    // scanner.js already flags password fields with sensitive:true
    if (element.sensitive) {
      return {
        blocked: true,
        reason:  "🛡️ Lemon never types into password fields.",
      };
    }

    // Build a flat record of the element's attributes for pattern testing
    const attrs = {
      type:         String(element.type        ?? ""),
      name:         String(element.name        ?? ""),
      id:           String(element.id          ?? ""),
      placeholder:  String(element.placeholder ?? ""),
      autocomplete: String(element.autocomplete ?? ""),
      "aria-label": String(element.label       ?? ""),
    };

    for (const [fieldClass, patterns] of Object.entries(SENSITIVE_FIELD_PATTERNS)) {
      for (const { attr, re } of patterns) {
        if (re.test(attrs[attr] ?? "")) {
          const label = {
            password:   "password",
            otp:        "OTP / verification code",
            cardNumber: "card number",
            cvv:        "CVV / CVC",
            pin:        "PIN",
          }[fieldClass] ?? fieldClass;
          return {
            blocked: true,
            reason:  `🛡️ Lemon never fills ${label} fields for your security.`,
          };
        }
      }
    }

    return { blocked: false, reason: "" };
  },

  /**
   * Flag actions targeting Submit / Pay / Send / Delete buttons that should require
   * an extra user confirmation before executing.
   *
   * Returns { blocked: false, needsConfirm: true } for these actions so the
   * caller can show a modal. If the user declines, the caller must call skip()
   * NOT tick() to avoid re-proposing the same action (edge case 16.4).
   *
   * @param {{ action: string, element: object|null }} action
   * @returns {{ blocked: boolean, needsConfirm: boolean, reason: string }}
   */
  checkAction(action) {
    if (!action) return { blocked: false, needsConfirm: false, reason: "" };

    const label = String(
      action.element?.label ?? action.value ?? ""
    ).trim();

    if (action.action === "click" || action.action === "type" || action.action === "select") {
      for (const re of CONFIRM_ACTION_PATTERNS) {
        if (re.test(label)) {
          return {
            blocked:      false,
            needsConfirm: true,
            reason:       `⚠️ This action ("${label}") may be consequential. Please confirm before Lemon proceeds.`,
          };
        }
      }
    }

    return { blocked: false, needsConfirm: false, reason: "" };
  },
};
