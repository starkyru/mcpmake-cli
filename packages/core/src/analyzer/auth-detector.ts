/**
 * Detects authentication flows from analyzed page descriptors.
 *
 * Scans forms, buttons, and links for patterns indicating login forms,
 * OAuth redirects, and active session indicators.
 */

import type {
  PageDescriptor,
  FormDescriptor,
  AuthFlowDescriptor,
  AuthFlowType,
  SelectorSet,
} from '../types/site.js';
import { logger } from '../utils/logger.js';

/** Patterns for detecting username/email fields. */
const USERNAME_PATTERNS = /user|email|login|account|e-mail/i;

/** Patterns for detecting password fields. */
const PASSWORD_PATTERNS = /pass|pwd|secret/i;

/** Patterns for detecting OAuth redirect buttons/links. */
const OAUTH_PATTERNS =
  /google|github|facebook|twitter|apple|microsoft|oauth|sso|sign.in.with|log.in.with/i;

/** Patterns for detecting session indicators (logged-in state). */
const SESSION_INDICATOR_PATTERNS = /log\s*out|sign\s*out|my\s*account|profile|avatar|dashboard/i;

/**
 * Detect the authentication flow from a set of analyzed pages.
 * Returns undefined if no auth flow is detected.
 */
export function detectAuthFlow(pages: PageDescriptor[]): AuthFlowDescriptor | undefined {
  // Try form-login detection first (most specific)
  const formLogin = detectFormLogin(pages);
  if (formLogin) {
    logger.info(`Detected auth flow: form-login on ${formLogin.loginPage?.url ?? 'unknown page'}`);
    return formLogin;
  }

  // Try OAuth redirect detection
  const oauthRedirect = detectOAuthRedirect(pages);
  if (oauthRedirect) {
    logger.info('Detected auth flow: oauth-redirect');
    return oauthRedirect;
  }

  // Check for session indicators without a visible login form
  const sessionOnly = detectSessionIndicators(pages);
  if (sessionOnly) {
    logger.info('Detected auth flow: cookie-session (session indicators found, no login form)');
    return sessionOnly;
  }

  logger.info('No authentication flow detected');
  return undefined;
}

// ─── Form Login Detection ─────────────────────────────────────────

function detectFormLogin(pages: PageDescriptor[]): AuthFlowDescriptor | undefined {
  for (const page of pages) {
    for (const form of page.forms) {
      const usernameField = findUsernameField(form);
      const passwordField = findPasswordField(form);

      if (usernameField && passwordField) {
        return {
          type: 'form-login' as AuthFlowType,
          loginPage: page,
          loginForm: form,
          usernameField: usernameField,
          passwordField: passwordField,
          submitButton: form.submitButton,
          sessionIndicator: findSessionIndicator(pages),
        };
      }
    }
  }

  return undefined;
}

function findUsernameField(form: FormDescriptor): SelectorSet | undefined {
  for (const field of form.fields) {
    if (field.fieldType === 'email') return field.selector;
    if (USERNAME_PATTERNS.test(field.name)) return field.selector;
    if (field.label && USERNAME_PATTERNS.test(field.label)) return field.selector;
    if (field.placeholder && USERNAME_PATTERNS.test(field.placeholder)) return field.selector;
  }
  return undefined;
}

function findPasswordField(form: FormDescriptor): SelectorSet | undefined {
  for (const field of form.fields) {
    if (field.fieldType === 'password') return field.selector;
    if (PASSWORD_PATTERNS.test(field.name)) return field.selector;
  }
  return undefined;
}

// ─── OAuth Detection ──────────────────────────────────────────────

function detectOAuthRedirect(pages: PageDescriptor[]): AuthFlowDescriptor | undefined {
  for (const page of pages) {
    // Check buttons for OAuth patterns
    for (const btn of page.buttons) {
      const text = btn.text ?? btn.ariaLabel ?? '';
      const href = btn.href ?? '';
      if (OAUTH_PATTERNS.test(text) || OAUTH_PATTERNS.test(href)) {
        return {
          type: 'oauth-redirect' as AuthFlowType,
          loginPage: page,
          sessionIndicator: findSessionIndicator(pages),
        };
      }
    }

    // Check links for OAuth patterns
    for (const link of page.links) {
      const text = link.text ?? '';
      if (OAUTH_PATTERNS.test(text) || OAUTH_PATTERNS.test(link.href)) {
        return {
          type: 'oauth-redirect' as AuthFlowType,
          loginPage: page,
          sessionIndicator: findSessionIndicator(pages),
        };
      }
    }
  }

  return undefined;
}

// ─── Session Indicator Detection ──────────────────────────────────

function findSessionIndicator(
  pages: PageDescriptor[],
): AuthFlowDescriptor['sessionIndicator'] | undefined {
  for (const page of pages) {
    // Check buttons for logout/profile patterns
    for (const btn of page.buttons) {
      const text = btn.text ?? btn.ariaLabel ?? '';
      if (SESSION_INDICATOR_PATTERNS.test(text)) {
        return { selector: btn.selector };
      }
    }

    // Check links for logout/profile patterns
    for (const link of page.links) {
      const text = link.text ?? '';
      if (SESSION_INDICATOR_PATTERNS.test(text) || SESSION_INDICATOR_PATTERNS.test(link.href)) {
        return { selector: link.selector };
      }
    }
  }

  return undefined;
}

function detectSessionIndicators(pages: PageDescriptor[]): AuthFlowDescriptor | undefined {
  const indicator = findSessionIndicator(pages);
  if (!indicator) return undefined;

  return {
    type: 'cookie-session' as AuthFlowType,
    sessionIndicator: indicator,
  };
}
