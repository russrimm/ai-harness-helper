import { describe, expect, it } from 'vitest';
import { createEnvironment, expandTemplate, expandTemplates, toDisplayPath } from '../src/paths.js';

describe('createEnvironment', () => {
  it('derives Windows locations from process environment variables', () => {
    const env = createEnvironment({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        ProgramData: 'C:\\ProgramData',
      },
    });

    expect(env.appData).toBe('C:\\Users\\dev\\AppData\\Roaming');
    expect(env.localAppData).toBe('C:\\Users\\dev\\AppData\\Local');
    expect(env.programData).toBe('C:\\ProgramData');
    expect(env.pathSeparator).toBe('\\');
  });

  it('falls back to conventional Windows paths when variables are absent', () => {
    const env = createEnvironment({ platform: 'win32', home: 'C:/Users/dev', env: {} });
    expect(env.appData).toBe('C:/Users/dev/AppData/Roaming');
    expect(env.programData).toBe('C:\\ProgramData');
  });

  it('uses Application Support on macOS', () => {
    const env = createEnvironment({ platform: 'darwin', home: '/Users/dev', env: {} });
    expect(env.appData).toBe('/Users/dev/Library/Application Support');
    expect(env.appSupport).toBe('/Users/dev/Library/Application Support');
    expect(env.programData).toBe('/Library/Application Support');
  });

  it('honours XDG variables on Linux', () => {
    const env = createEnvironment({
      platform: 'linux',
      home: '/home/dev',
      env: { XDG_CONFIG_HOME: '/home/dev/.custom-config' },
    });
    expect(env.xdgConfig).toBe('/home/dev/.custom-config');
    expect(env.appData).toBe('/home/dev/.custom-config');
    expect(env.programData).toBe('/etc');
  });

  it('defaults Linux config to ~/.config', () => {
    const env = createEnvironment({ platform: 'linux', home: '/home/dev', env: {} });
    expect(env.xdgConfig).toBe('/home/dev/.config');
    expect(env.localAppData).toBe('/home/dev/.local/share');
  });

  it('treats unknown platforms as Linux', () => {
    const env = createEnvironment({ home: '/home/dev', env: {} });
    expect(['win32', 'darwin', 'linux']).toContain(env.platform);
  });
});

describe('expandTemplate', () => {
  const win = createEnvironment({
    platform: 'win32',
    home: 'C:\\Users\\dev',
    env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' },
  });
  const mac = createEnvironment({ platform: 'darwin', home: '/Users/dev', env: {} });

  it('expands the home token and normalizes separators for Windows', () => {
    expect(expandTemplate('{home}/.claude/settings.json', win)).toBe(
      'C:\\Users\\dev\\.claude\\settings.json',
    );
  });

  it('expands appData and programData tokens', () => {
    expect(expandTemplate('{appData}/Claude/claude_desktop_config.json', win)).toBe(
      'C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    );
    expect(expandTemplate('{programData}/ClaudeCode/managed-settings.json', win)).toBe(
      'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
    );
  });

  it('keeps POSIX separators for non-Windows platforms', () => {
    expect(expandTemplate('{home}/.codex/config.toml', mac)).toBe('/Users/dev/.codex/config.toml');
  });

  it('returns undefined when {project} is used without a project root', () => {
    expect(expandTemplate('{project}/.mcp.json', mac)).toBeUndefined();
  });

  it('expands {project} when a root is supplied', () => {
    expect(expandTemplate('{project}/.mcp.json', mac, '/Users/dev/code/app')).toBe(
      '/Users/dev/code/app/.mcp.json',
    );
  });

  it('collapses duplicate separators', () => {
    expect(expandTemplate('{home}//.claude///agents', mac)).toBe('/Users/dev/.claude/agents');
  });
});

describe('expandTemplates', () => {
  const linux = createEnvironment({ platform: 'linux', home: '/home/dev', env: {} });

  it('prefers platform-specific templates over the shared list', () => {
    const result = expandTemplates(
      { all: ['{home}/shared'], linux: ['{home}/.config/linux-only'] },
      linux,
    );
    expect(result).toEqual(['/home/dev/.config/linux-only']);
  });

  it('falls back to the shared list when no platform entry exists', () => {
    const result = expandTemplates({ all: ['{home}/shared'] }, linux);
    expect(result).toEqual(['/home/dev/shared']);
  });

  it('deduplicates identical expansions', () => {
    const result = expandTemplates({ all: ['{home}/a', '{home}//a', '{home}/b'] }, linux);
    expect(result).toEqual(['/home/dev/a', '/home/dev/b']);
  });

  it('deduplicates case-insensitively on Windows', () => {
    const win = createEnvironment({ platform: 'win32', home: 'C:\\Users\\dev', env: {} });
    const result = expandTemplates({ all: ['{home}/Foo', '{home}/foo'] }, win);
    expect(result).toHaveLength(1);
  });

  it('drops project templates during a global scan', () => {
    const result = expandTemplates({ all: ['{project}/.mcp.json', '{home}/.mcp.json'] }, linux);
    expect(result).toEqual(['/home/dev/.mcp.json']);
  });
});

describe('toDisplayPath', () => {
  it('abbreviates the home directory', () => {
    const linux = createEnvironment({ platform: 'linux', home: '/home/dev', env: {} });
    expect(toDisplayPath('/home/dev/.claude/settings.json', linux)).toBe('~/.claude/settings.json');
    expect(toDisplayPath('/etc/claude-code/managed-settings.json', linux)).toBe(
      '/etc/claude-code/managed-settings.json',
    );
  });

  it('is case-insensitive on Windows', () => {
    const win = createEnvironment({ platform: 'win32', home: 'C:\\Users\\dev', env: {} });
    expect(toDisplayPath('c:\\users\\dev\\.claude\\settings.json', win)).toBe(
      '~\\.claude\\settings.json',
    );
  });

  it('does not abbreviate a sibling directory with a shared prefix', () => {
    const linux = createEnvironment({ platform: 'linux', home: '/home/dev', env: {} });
    expect(toDisplayPath('/home/developer/.claude', linux)).toBe('/home/developer/.claude');
  });
});
