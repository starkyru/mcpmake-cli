/**
 * Type definitions for the Website-to-MCP pipeline.
 *
 * These types represent DOM-based interactions (forms, buttons, links)
 * rather than HTTP API calls. They form a parallel pipeline to the
 * existing OperationDescriptor/ToolDefinition types in index.ts.
 */

import type { EnvVarDescriptor, TransportMode } from './index.js';

// ─── Selector Strategy ─────────────────────────────────────────────

export type SelectorStrategy =
  | 'data-testid'
  | 'id'
  | 'aria-label'
  | 'name'
  | 'role'
  | 'css-path'
  | 'xpath';

export interface SelectorSet {
  /** Best available selector string */
  primary: string;
  /** Ordered fallback selectors */
  fallbacks: string[];
  /** Strategy used for the primary selector */
  strategy: SelectorStrategy;
  /** 0-1 confidence score for selector stability */
  confidence: number;
  /** LLM-inferred human-readable label, e.g. "Login button" */
  humanLabel?: string;
}

// ─── Element Descriptors ────────────────────────────────────────────

export type FormFieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'tel'
  | 'url'
  | 'search'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'textarea'
  | 'hidden'
  | 'file'
  | 'date'
  | 'datetime-local'
  | 'color'
  | 'range'
  | 'other';

export interface FormFieldDescriptor {
  /** Form field name attribute */
  name: string;
  /** Input type */
  fieldType: FormFieldType;
  /** Selector set for this field */
  selector: SelectorSet;
  /** Associated <label> text or aria-label */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the field is required */
  required: boolean;
  /** Options for <select>, radio groups, and datalists */
  options?: string[];
  /** Default or current value */
  defaultValue?: string;
}

export interface FormDescriptor {
  /** Generated stable ID for this form */
  formId: string;
  /** Form action URL (if present) */
  action?: string;
  /** Form method */
  method: 'get' | 'post';
  /** Selector set for the <form> element */
  selector: SelectorSet;
  /** Fields within the form */
  fields: FormFieldDescriptor[];
  /** Submit button selector */
  submitButton?: SelectorSet;
  /** LLM-inferred semantic name, e.g. "login_form", "search_form" */
  semanticName?: string;
  /** LLM-inferred description of what this form does */
  description?: string;
}

export interface ButtonDescriptor {
  /** Generated stable ID */
  buttonId: string;
  /** Selector set for the button element */
  selector: SelectorSet;
  /** Visible button text */
  text?: string;
  /** aria-label value */
  ariaLabel?: string;
  /** LLM-inferred action, e.g. "add_to_cart", "submit_order" */
  semanticAction?: string;
  /** LLM-inferred description */
  description?: string;
  /** Button type */
  type: 'submit' | 'button' | 'link' | 'other';
  /** href for link-style buttons */
  href?: string;
}

export interface LinkDescriptor {
  /** Generated stable ID */
  linkId: string;
  /** Selector set for the <a> element */
  selector: SelectorSet;
  /** Visible link text */
  text?: string;
  /** Link destination */
  href: string;
  /** Whether this link navigates to a new page (vs anchor/JS action) */
  isNavigation: boolean;
  /** LLM-inferred semantic action */
  semanticAction?: string;
}

// ─── Page Descriptor ────────────────────────────────────────────────

export interface PageDescriptor {
  /** Generated stable ID */
  pageId: string;
  /** Canonical URL of the page */
  url: string;
  /** URL pattern for parameterized pages (e.g. /products/:id) */
  urlPattern?: string;
  /** Page title from <title> or first <h1> */
  title?: string;
  /** LLM-inferred semantic name, e.g. "login_page", "search_results" */
  semanticName?: string;
  /** LLM-inferred description */
  description?: string;
  /** Forms discovered on this page */
  forms: FormDescriptor[];
  /** Standalone buttons (not inside forms) */
  buttons: ButtonDescriptor[];
  /** Links discovered on this page */
  links: LinkDescriptor[];
  /** SHA-256 hash of the analysis screenshot */
  screenshotHash?: string;
  /** ISO timestamp of when this page was analyzed */
  analyzedAt: string;
}

// ─── Auth Flow ──────────────────────────────────────────────────────

export type AuthFlowType =
  | 'form-login'
  | 'oauth-redirect'
  | 'basic-auth'
  | 'cookie-session'
  | 'unknown';

export interface AuthFlowDescriptor {
  /** Detected auth mechanism */
  type: AuthFlowType;
  /** The page containing the login form */
  loginPage?: PageDescriptor;
  /** The login form descriptor */
  loginForm?: FormDescriptor;
  /** Selector for the username/email field */
  usernameField?: SelectorSet;
  /** Selector for the password field */
  passwordField?: SelectorSet;
  /** Selector for the submit/login button */
  submitButton?: SelectorSet;
  /** How to detect if the user is currently logged in */
  sessionIndicator?: {
    /** Element present when logged in (e.g. user avatar, logout button) */
    selector?: SelectorSet;
    /** Cookie name that indicates an active session */
    cookie?: string;
    /** URL pattern after successful login (e.g. /dashboard) */
    urlPattern?: string;
  };
}

// ─── Site Descriptor (top-level) ────────────────────────────────────

export interface SiteDescriptor {
  /** Unique identifier for this site analysis */
  siteId: string;
  /** Base URL of the site */
  baseUrl: string;
  /** All discovered pages */
  pages: PageDescriptor[];
  /** Detected authentication flow */
  authFlow?: AuthFlowDescriptor;
  /** ISO timestamp of the analysis */
  analyzedAt: string;
  /** Version number, incremented on rescan */
  version: number;
  /** How deep the crawler went */
  crawlDepth: number;
  /** Site metadata */
  metadata: {
    title?: string;
    description?: string;
    favicon?: string;
  };
}

// ─── Site Tool Definition ───────────────────────────────────────────

export type SiteToolType = 'page-action' | 'element-action' | 'navigation' | 'browser-lifecycle';

export interface SiteToolDefinition {
  /** Tool name (kebab-case, MCP-compatible) */
  name: string;
  /** Human-readable title */
  title: string;
  /** Tool description */
  description: string;
  /** Zod schema code for tool input parameters */
  inputSchemaCode: string;
  /** Output file name */
  fileName: string;
  /** Generated function name (camelCase) */
  functionName: string;

  /** What kind of site tool this is */
  toolType: SiteToolType;
  /** Which page this tool operates on */
  pageId?: string;
  /** Page URL for navigation */
  pageUrl?: string;
  /** Form descriptor (for form-based page-action tools) */
  form?: FormDescriptor;
  /** Button descriptor (for element-action tools) */
  button?: ButtonDescriptor;
  /** Link descriptor (for navigation tools) */
  link?: LinkDescriptor;
  /** All selectors this tool depends on */
  selectors: SelectorSet[];
  /** Whether this tool returns a screenshot alongside text */
  returnsScreenshot: boolean;

  /** MCP tool annotations */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

// ─── Site Project Manifest ──────────────────────────────────────────

export interface BrowserConfig {
  /** Run browser in headless mode */
  headless: boolean;
  /** Idle timeout before auto-closing browser (ms) */
  idleTimeoutMs: number;
  /** Browser viewport dimensions */
  viewport: { width: number; height: number };
  /** Custom user agent string */
  userAgent?: string;
  /** Maximum concurrent browser sessions (default: 10) */
  maxSessions?: number;
}

export interface SiteProjectManifest {
  /** Server name (kebab-case) */
  serverName: string;
  /** Server version */
  serverVersion: string;
  /** Target website base URL */
  baseUrl: string;
  /** MCP transport mode */
  transport: TransportMode;
  /** Full site descriptor (embedded in generated project) */
  siteDescriptor: SiteDescriptor;
  /** Generated tools */
  tools: SiteToolDefinition[];
  /** Environment variables the generated server needs */
  envVars: EnvVarDescriptor[];
  /** Playwright browser configuration */
  browserConfig: BrowserConfig;
}

/**
 * Regeneration metadata written to the generated project root as
 * `mcpmake.site.json` so `mcpmake rescan` can rebuild the project from a
 * freshly crawled SiteDescriptor without re-specifying the original CLI flags.
 * The SiteDescriptor itself lives in `src/site-descriptor.json` and the tools
 * are regenerated deterministically, so neither is duplicated here.
 */
export interface SiteRegenMetadata {
  serverName: string;
  serverVersion: string;
  transport: TransportMode;
  baseUrl: string;
  envVars: EnvVarDescriptor[];
  browserConfig: BrowserConfig;
}

// ─── Rescan Types ───────────────────────────────────────────────────

export type ChangeType = 'added' | 'removed' | 'modified' | 'selector-broken';
export type ElementType = 'page' | 'form' | 'button' | 'link' | 'field';

export interface SiteChangeEntry {
  /** What kind of change */
  changeType: ChangeType;
  /** What kind of element changed */
  elementType: ElementType;
  /** ID of the element that changed */
  elementId: string;
  /** Page where the change occurred */
  pageId: string;
  /** Human-readable description of the change */
  description: string;
  /** ISO timestamp */
  timestamp: string;
  /** Previous value (for modified/removed) */
  oldValue?: unknown;
  /** New value (for added/modified) */
  newValue?: unknown;
}

export interface RescanResult {
  /** Previous site descriptor version */
  previousVersion: number;
  /** New version number */
  newVersion: number;
  /** All changes detected */
  changes: SiteChangeEntry[];
  /** Selectors that no longer resolve */
  brokenSelectors: Array<{
    toolName: string;
    selector: SelectorSet;
    /** New selector if self-healing succeeded */
    healedSelector?: SelectorSet;
  }>;
  /** Updated site descriptor */
  newSiteDescriptor: SiteDescriptor;
  /** ISO timestamp of the rescan */
  timestamp: string;
}
