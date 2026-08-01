import { describe, expect, it } from 'vitest';
import { allLocations, providers, providersById } from '../src/registry.js';
import { createEnvironment, expandTemplates } from '../src/paths.js';
import type { PlatformId } from '../src/types.js';

const VALID_TOKENS = new Set([
  'home',
  'appData',
  'localAppData',
  'programData',
  'xdgConfig',
  'appSupport',
  'project',
]);

const PLATFORMS: PlatformId[] = ['win32', 'darwin', 'linux'];

describe('provider registry', () => {
  it('exposes at least the core agentic tools', () => {
    for (const id of ['claude-code', 'copilot-cli', 'cursor', 'codex', 'vscode', 'docker']) {
      expect(providersById.has(id), `missing provider ${id}`).toBe(true);
    }
  });

  it('uses unique provider identifiers', () => {
    const ids = providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses location identifiers unique within each provider', () => {
    for (const provider of providers) {
      const ids = provider.locations.map((l) => l.id);
      expect(new Set(ids).size, `duplicate location id in ${provider.id}`).toBe(ids.length);
    }
  });

  it('declares at least one location per provider', () => {
    for (const provider of providers) {
      expect(provider.locations.length, `${provider.id} has no locations`).toBeGreaterThan(0);
    }
  });

  it('only references tokens the resolver understands', () => {
    for (const { provider, location } of allLocations()) {
      for (const templates of Object.values(location.paths)) {
        for (const template of templates ?? []) {
          for (const [, token] of template.matchAll(/\{(\w+)\}/g)) {
            expect(
              VALID_TOKENS.has(token),
              `${provider.id}/${location.id} uses unknown token {${token}}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('starts every template with a token so no path is relative', () => {
    for (const { provider, location } of allLocations()) {
      for (const templates of Object.values(location.paths)) {
        for (const template of templates ?? []) {
          const isAbsolutePosix = template.startsWith('/');
          expect(
            template.startsWith('{') || isAbsolutePosix,
            `${provider.id}/${location.id} template "${template}" is not anchored`,
          ).toBe(true);
        }
      }
    }
  });

  it('declares at least one path for every location', () => {
    for (const { provider, location } of allLocations()) {
      const total = Object.values(location.paths).reduce(
        (sum, list) => sum + (list?.length ?? 0),
        0,
      );
      expect(total, `${provider.id}/${location.id} declares no paths`).toBeGreaterThan(0);
    }
  });

  it('gives directory locations glob patterns and file locations none', () => {
    for (const { provider, location } of allLocations()) {
      if (location.directory) {
        expect(
          location.patterns && location.patterns.length > 0,
          `${provider.id}/${location.id} is a directory but has no patterns`,
        ).toBe(true);
      } else {
        expect(
          location.patterns,
          `${provider.id}/${location.id} has patterns but is not a directory`,
        ).toBeUndefined();
      }
    }
  });

  it('scopes {project} templates to project locations and vice versa', () => {
    for (const { provider, location } of allLocations()) {
      const templates = Object.values(location.paths).flatMap((list) => list ?? []);
      const usesProject = templates.some((t) => t.includes('{project}'));
      expect(usesProject, `${provider.id}/${location.id} scope/token mismatch`).toBe(
        location.scope === 'project',
      );
    }
  });

  it('never marks a credential store as editable content', () => {
    for (const { provider, location } of allLocations()) {
      if (location.kind === 'credential') {
        expect(
          location.sensitivity,
          `${provider.id}/${location.id} must be a credential-store`,
        ).toBe('credential-store');
      }
    }
  });

  it('resolves to absolute paths on every platform', () => {
    for (const platform of PLATFORMS) {
      const home = platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
      const projectRoot = platform === 'win32' ? 'C:\\code\\project' : '/home/dev/project';
      const env = createEnvironment({
        platform,
        home,
        env:
          platform === 'win32'
            ? {
                APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
                LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
                ProgramData: 'C:\\ProgramData',
              }
            : {},
      });

      for (const { provider, location } of allLocations()) {
        const resolved = expandTemplates(location.paths, env, projectRoot);
        expect(
          resolved.length,
          `${provider.id}/${location.id} resolved to nothing on ${platform}`,
        ).toBeGreaterThan(0);

        for (const path of resolved) {
          const absolute = platform === 'win32' ? /^[A-Za-z]:\\/.test(path) : path.startsWith('/');
          expect(absolute, `${provider.id}/${location.id} produced relative path "${path}"`).toBe(
            true,
          );
        }
      }
    }
  });

  it('produces no duplicate absolute paths across providers for the same scope', () => {
    const env = createEnvironment({ platform: 'linux', home: '/home/dev', env: {} });
    const seen = new Map<string, string>();

    for (const { provider, location } of allLocations()) {
      if (location.scope === 'project') continue;
      for (const path of expandTemplates(location.paths, env)) {
        const owner = `${provider.id}/${location.id}`;
        const previous = seen.get(path);
        // The same file legitimately belongs to one owner only; a collision
        // means two providers would both claim (and both offer to edit) it.
        expect(previous, `${path} claimed by both ${previous} and ${owner}`).toBeUndefined();
        seen.set(path, owner);
      }
    }
  });
});
