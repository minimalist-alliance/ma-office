// The bandwidth pause on the real test desk (task 33 item 1), kept outside `testDir: 'tests'` so the release gate never
// sees it: it writes staging's test knob on the test desk's row, and puts it back. The spec also skips unless
// BANDWIDTH_PAUSE=1. Same browser as the gate's.
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

export default defineConfig({ ...base, testDir: '.', testMatch: '*.spec.ts', outputDir: 'test-results' });
