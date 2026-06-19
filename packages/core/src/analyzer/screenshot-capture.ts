/**
 * Captures and hashes screenshots during site analysis.
 * Screenshots serve as the baseline for rescan comparison
 * and are returned with every tool call at runtime.
 */

import type { Page } from 'playwright';
import crypto from 'node:crypto';

export interface ScreenshotResult {
  /** Raw PNG buffer */
  data: Buffer;
  /** SHA-256 hash for deduplication */
  hash: string;
  /** Viewport dimensions at capture time */
  viewport: { width: number; height: number };
}

/**
 * Take a full-page screenshot and compute its hash.
 */
export async function captureFullPageScreenshot(page: Page): Promise<ScreenshotResult> {
  const data = await page.screenshot({
    type: 'png',
    fullPage: true,
  });

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  return {
    data,
    hash: hashScreenshot(data),
    viewport,
  };
}

/**
 * Take a viewport-only screenshot (what the user sees).
 */
export async function captureViewportScreenshot(page: Page): Promise<ScreenshotResult> {
  const data = await page.screenshot({
    type: 'png',
    fullPage: false,
  });

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  return {
    data,
    hash: hashScreenshot(data),
    viewport,
  };
}

/**
 * Compute SHA-256 hash of a screenshot buffer.
 */
export function hashScreenshot(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
