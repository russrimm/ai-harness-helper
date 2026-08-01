// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DiscoveredFile,
  HarnessInventory,
  HarnessSummary,
  OverviewResponse,
  ScanResponse,
} from '../src/api/types.js';

const api = vi.hoisted(() => ({
  addProject: vi.fn(),
  fetchExport: vi.fn(),
  getFile: vi.fn(),
  getHealth: vi.fn(),
  getInventory: vi.fn(),
  getOverview: vi.fn(),
  getProjects: vi.fn(),
  getScan: vi.fn(),
  postScan: vi.fn(),
  putFile: vi.fn(),
  removeProject: vi.fn(),
  revealFileValue: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../src/api/client.js', () => api);

import { App } from '../src/App.js';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const summary: HarnessSummary = {
  providerCount: 1,
  fileCount: 1,
  mcpServerCount: 1,
  mcpDefinitionCount: 1,
  instructionCount: 1,
  capabilityCount: 1,
  guardrailCount: 1,
  findingCount: 0,
  errorCount: 0,
  warningCount: 0,
  totalBytes: 42,
};

const file: DiscoveredFile = {
  id: 'file-1',
  path: 'C:\\synthetic\\AGENTS.md',
  displayPath: '~\\AGENTS.md',
  name: 'AGENTS.md',
  providerId: 'synthetic',
  providerName: 'Synthetic Tool',
  locationId: 'instructions',
  locationLabel: 'Instructions',
  scope: 'user',
  kind: 'instructions',
  format: 'markdown',
  sensitivity: 'normal',
  size: 42,
  modified: '2026-07-31T00:00:00.000Z',
  hash: 'synthetic-hash',
};

const scan: ScanResponse = {
  scannedAt: '2026-07-31T00:00:00.000Z',
  platform: 'win32',
  home: 'C:\\synthetic',
  files: [file],
  missing: [],
  problems: [],
  projectRoots: [],
  detectedProviders: ['synthetic'],
  durationMs: 1,
  tree: [{ providerId: 'synthetic', providerName: 'Synthetic Tool', files: [file] }],
};

const overview: OverviewResponse = {
  summary,
  findings: [],
  platform: scan.platform,
  scannedAt: scan.scannedAt,
  durationMs: scan.durationMs,
  projectRoots: [],
  detectedProviders: scan.detectedProviders,
  missingCount: 0,
  tree: scan.tree,
};

const inventory: HarnessInventory = {
  summary,
  mcpServers: [
    {
      name: 'synthetic-server',
      definitions: [
        {
          fileId: file.id,
          filePath: file.path,
          displayPath: file.displayPath,
          providerId: file.providerId,
          providerName: file.providerName,
          scope: file.scope,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          envKeys: [],
          hasInlineSecret: false,
          disabled: false,
          signature: 'synthetic-signature',
        },
      ],
      providerIds: [file.providerId],
      conflicting: false,
      duplicated: false,
    },
  ],
  instructions: [
    {
      fileId: file.id,
      displayPath: file.displayPath,
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      title: 'Synthetic instructions',
      bytes: file.size,
      lineCount: 3,
      precedence: 2,
    },
  ],
  capabilities: [
    {
      fileId: 'agent-1',
      displayPath: '~\\agent.md',
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      kind: 'agent',
      name: 'Synthetic agent',
    },
  ],
  guardrails: [
    {
      fileId: 'guardrail-1',
      displayPath: '~\\.aiignore',
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      kind: 'ignore',
      allow: [],
      deny: [],
      ask: [],
      hooks: [],
      ignorePatterns: ['dist/**'],
    },
  ],
  findings: [],
  parsedFileIds: [file.id],
};

beforeEach(() => {
  api.getHealth.mockResolvedValue({ ok: true, readOnly: false });
  api.getInventory.mockResolvedValue(inventory);
  api.getOverview.mockResolvedValue(overview);
  api.getScan.mockResolvedValue(scan);
  api.search.mockResolvedValue({ query: '', hits: [], truncated: false, filesSearched: 1 });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

async function renderRoute(hash: string, heading: string): Promise<void> {
  window.location.hash = hash;
  render(<App />);
  await screen.findByRole('heading', { name: heading });
}

function expectValidHeadingOrder(): void {
  const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
    Number(heading.tagName.slice(1)),
  );
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1);
  }
}

describe('web accessibility', () => {
  it.each([
    ['#/', 'Overview'],
    ['#/files', 'Files'],
    ['#/mcp', 'MCP servers'],
    ['#/instructions', 'Instructions'],
    ['#/search', 'Search'],
    ['#/export', 'Export'],
  ])('has no detectable violations on %s', async (hash, heading) => {
    await renderRoute(hash, heading);

    const results = await axe.run(document.body, {
      rules: {
        // jsdom has no layout engine; color contrast requires a real browser canvas.
        'color-contrast': { enabled: false },
      },
    });
    expect(
      results.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.flatMap((node) => node.target),
      })),
    ).toEqual([]);
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelectorAll('nav[aria-label="Main"]')).toHaveLength(1);
    expectValidHeadingOrder();
    for (const button of document.querySelectorAll('button')) {
      expect(button.textContent?.trim() || button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('provides a predictable keyboard focus order with visible focus styling', async () => {
    const user = userEvent.setup();
    await renderRoute('#/', 'Overview');

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to main content' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Theme' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Overview' }));

    const css = await readFile(resolve('packages/web/src/styles.css'), 'utf8');
    expect(css).toMatch(/:focus-visible[\s\S]*outline:\s*3px solid/);
    expect(css).not.toMatch(/outline:\s*none/);
  });

  it('provides a reduced-motion override', async () => {
    const css = await readFile(resolve('packages/web/src/styles.css'), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms');
    expect(css).toContain('transition-duration: 0.01ms');
  });
});
