import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import type { PlatformId, PlatformPaths, ResolverEnvironment } from './types.js';

/** Tokens accepted inside location path templates. */
const TOKEN_PATTERN = /\{(home|appData|localAppData|programData|xdgConfig|appSupport|project)\}/g;

export interface CreateEnvironmentOptions {
  /** Override the detected platform. Used by tests and cross-platform docs. */
  readonly platform?: PlatformId;
  /** Override the detected home directory. */
  readonly home?: string;
  /** Raw process environment to read platform variables from. */
  readonly env?: NodeJS.ProcessEnv;
}

function normalizePlatform(value: string): PlatformId {
  if (value === 'win32' || value === 'darwin') return value;
  // Every other Node platform (linux, freebsd, openbsd, sunos, aix) follows
  // XDG conventions closely enough to share the linux rules.
  return 'linux';
}

/**
 * Builds the environment that path templates are expanded against.
 *
 * All inputs are injectable so the resolver can be exercised for every
 * platform from a single test run.
 */
export function createEnvironment(options: CreateEnvironmentOptions = {}): ResolverEnvironment {
  const env = options.env ?? process.env;
  const platform = options.platform ?? normalizePlatform(process.platform);
  const home = options.home ?? env['HOME'] ?? env['USERPROFILE'] ?? homedir();

  const appData =
    platform === 'win32'
      ? (env['APPDATA'] ?? joinPosix(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? joinPosix(home, 'Library', 'Application Support')
        : (env['XDG_CONFIG_HOME'] ?? joinPosix(home, '.config'));

  const localAppData =
    platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? joinPosix(home, 'AppData', 'Local'))
      : platform === 'darwin'
        ? joinPosix(home, 'Library', 'Application Support')
        : (env['XDG_DATA_HOME'] ?? joinPosix(home, '.local', 'share'));

  const programData =
    platform === 'win32'
      ? (env['ProgramData'] ?? 'C:\\ProgramData')
      : platform === 'darwin'
        ? '/Library/Application Support'
        : '/etc';

  const xdgConfig =
    platform === 'win32' ? appData : (env['XDG_CONFIG_HOME'] ?? joinPosix(home, '.config'));

  const appSupport =
    platform === 'darwin' ? joinPosix(home, 'Library', 'Application Support') : appData;

  return {
    platform,
    home,
    appData,
    localAppData,
    programData,
    xdgConfig,
    appSupport,
    pathSeparator: platform === 'win32' ? '\\' : '/',
  };
}

function joinPosix(...parts: string[]): string {
  return parts.join('/');
}

/**
 * Expands `{token}` placeholders in a single template.
 *
 * Returns `undefined` when the template references `{project}` but no project
 * root was supplied, which keeps project-scoped templates out of global scans.
 */
export function expandTemplate(
  template: string,
  env: ResolverEnvironment,
  projectRoot?: string,
): string | undefined {
  let unresolved = false;

  const expanded = template.replace(TOKEN_PATTERN, (_match, token: string) => {
    switch (token) {
      case 'home':
        return env.home;
      case 'appData':
        return env.appData;
      case 'localAppData':
        return env.localAppData;
      case 'programData':
        return env.programData;
      case 'xdgConfig':
        return env.xdgConfig;
      case 'appSupport':
        return env.appSupport;
      case 'project':
        if (projectRoot === undefined) {
          unresolved = true;
          return '';
        }
        return projectRoot;
      default:
        unresolved = true;
        return '';
    }
  });

  if (unresolved) return undefined;
  return normalizeAbsolute(expanded, env.platform);
}

/**
 * Normalizes a path for the target platform without touching the real
 * filesystem, so Windows layouts can be resolved on Linux and vice versa.
 */
export function normalizeAbsolute(input: string, platform: PlatformId): string {
  const windowsNetworkPath = platform === 'win32' && /^[\\/]{2}/.test(input);
  let collapsed = input.replace(/[\\/]+/g, platform === 'win32' ? '\\' : '/');
  if (windowsNetworkPath) collapsed = `\\${collapsed}`;
  const trimmed =
    collapsed.length > 3 && (collapsed.endsWith('\\') || collapsed.endsWith('/'))
      ? collapsed.slice(0, -1)
      : collapsed;

  // Only use Node's platform-specific normalization when it matches the
  // target, otherwise separators get rewritten for the wrong OS.
  if (platform === normalizePlatform(process.platform)) {
    return isAbsolute(trimmed) ? normalize(trimmed) : resolve(trimmed);
  }
  return trimmed;
}

/** Selects the template list that applies to the environment's platform. */
export function selectPlatformTemplates(
  paths: PlatformPaths,
  platform: PlatformId,
): readonly string[] {
  const specific = paths[platform];
  if (specific && specific.length > 0) return specific;
  return paths.all ?? [];
}

/**
 * Expands every template for a location on the current platform.
 * Duplicate results are collapsed while preserving declaration order.
 */
export function expandTemplates(
  paths: PlatformPaths,
  env: ResolverEnvironment,
  projectRoot?: string,
): string[] {
  const templates = selectPlatformTemplates(paths, env.platform);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const template of templates) {
    const expanded = expandTemplate(template, env, projectRoot);
    if (expanded === undefined) continue;
    const key = env.platform === 'win32' ? expanded.toLowerCase() : expanded;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(expanded);
  }

  return out;
}

/** Replaces the home-directory prefix with `~` for display purposes. */
export function toDisplayPath(absolutePath: string, env: ResolverEnvironment): string {
  const home = env.home;
  const matches =
    env.platform === 'win32'
      ? absolutePath.toLowerCase().startsWith(home.toLowerCase())
      : absolutePath.startsWith(home);
  if (!matches) return absolutePath;
  const rest = absolutePath.slice(home.length);
  if (rest === '') return '~';
  if (rest.startsWith('\\') || rest.startsWith('/')) return `~${rest}`;
  return absolutePath;
}

/** The platform-native separator, exported for callers building paths. */
export const nativeSeparator = sep;
