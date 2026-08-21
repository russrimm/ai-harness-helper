/**
 * The one place in this tool that talks to the network.
 *
 * Everything else here is deliberately offline: the process can read every
 * credential-adjacent file on the machine, so "it never calls out" is a
 * property a user can verify rather than a promise they have to trust. An
 * update check cannot be that, so it is opt-in per run (`--check-updates`),
 * never cached to disk, and never enabled by a config file — nothing except an
 * explicit flag on the command line can make this module reach the network.
 *
 * What is sent is only what any HTTP request must send: the URL, a User-Agent
 * naming the tool and its version, and no credentials at all. Nothing about
 * the scanned harness leaves the machine, so this stays a version lookup and
 * never becomes telemetry.
 */

const RELEASES_ENDPOINT = 'https://api.github.com/repos/russrimm/ai-harness-helper/releases/latest';

/** The repository this build reports as its home, shown on the About page. */
export const REPOSITORY_URL = 'https://github.com/russrimm/ai-harness-helper';

/** Long enough for a slow link, short enough not to delay the UI opening. */
const TIMEOUT_MS = 3000;

/** A release body is untrusted input; only the tag is read, and only if it is small. */
const MAX_TAG_CHARS = 64;

export type UpdateCheck =
  /** The flag was not passed. The default for every run. */
  | { status: 'disabled' }
  | { status: 'current'; currentVersion: string; latestVersion: string }
  | { status: 'outdated'; currentVersion: string; latestVersion: string; releaseUrl: string }
  /** Reached GitHub, or tried to, and could not get an answer worth showing. */
  | { status: 'failed'; currentVersion: string; reason: string };

interface ParsedVersion {
  readonly release: readonly number[];
  readonly prerelease: string | undefined;
}

/**
 * Parses the subset of semver this project actually publishes.
 *
 * A full semver implementation would be a dependency, and this tool keeps its
 * dependency surface small on purpose — it is the thing that reads your
 * credentials. Anything unparseable returns `undefined` so the caller reports
 * "could not tell" rather than guessing a comparison.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

/** Returns 1 when `a` is newer than `b`, -1 when older, 0 when equal. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a.release[index] ?? 0;
    const right = b.release[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }

  // A prerelease sorts before the release it leads to: 1.2.0-rc.1 < 1.2.0.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease > b.prerelease ? 1 : a.prerelease < b.prerelease ? -1 : 0;
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewer(latest: string, current: string): boolean | undefined {
  const parsedLatest = parseVersion(latest);
  const parsedCurrent = parseVersion(current);
  if (!parsedLatest || !parsedCurrent) return undefined;
  return compareVersions(parsedLatest, parsedCurrent) > 0;
}

/**
 * Reads the tag out of a releases response.
 *
 * The payload is treated as hostile: only `tag_name` is read, it must be a
 * short string, and it must parse as a version before it is shown anywhere.
 * The release URL is rebuilt from the repository constant and the validated
 * tag rather than taken from the response, so a compromised or spoofed
 * endpoint cannot put an arbitrary link in front of the user.
 */
export function readLatestTag(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const tag = (payload as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_CHARS) return undefined;
  return parseVersion(tag) ? tag.trim() : undefined;
}

export interface CheckOptions {
  /** Injected by tests. Production always uses the global. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Asks GitHub for the latest release.
 *
 * Never throws and never rejects: a failed update check is a footnote on an
 * About page, and must not be able to stop a scan from being shown or take the
 * CLI down with it.
 */
export async function checkForUpdates(
  currentVersion: string,
  options: CheckOptions = {},
): Promise<UpdateCheck> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { status: 'failed', currentVersion, reason: 'This Node build has no fetch available.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  try {
    const response = await fetchImpl(RELEASES_ENDPOINT, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `ai-harness-helper/${currentVersion}`,
      },
    });

    if (!response.ok) {
      return {
        status: 'failed',
        currentVersion,
        reason:
          response.status === 404
            ? 'No releases have been published yet.'
            : `GitHub answered with status ${response.status}.`,
      };
    }

    const latestTag = readLatestTag(await response.json());
    if (latestTag === undefined) {
      return { status: 'failed', currentVersion, reason: 'GitHub returned no usable version tag.' };
    }

    const latestVersion = latestTag.replace(/^v/, '');
    const newer = isNewer(latestVersion, currentVersion);
    if (newer === undefined) {
      return {
        status: 'failed',
        currentVersion,
        reason: `Could not compare "${currentVersion}" with "${latestVersion}".`,
      };
    }

    return newer
      ? {
          status: 'outdated',
          currentVersion,
          latestVersion,
          releaseUrl: `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(latestTag)}`,
        }
      : { status: 'current', currentVersion, latestVersion };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'failed',
      currentVersion,
      reason: aborted
        ? 'The update check timed out.'
        : 'Could not reach GitHub to check for updates.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One line for the terminal banner, or nothing when there is no news. */
export function formatUpdateNotice(check: UpdateCheck): string | undefined {
  switch (check.status) {
    case 'outdated':
      return (
        `  Update available: ${check.currentVersion} → ${check.latestVersion}\n` +
        `  ${check.releaseUrl}\n`
      );
    case 'current':
      return `  Up to date (${check.currentVersion}).\n`;
    case 'failed':
      return `  Update check failed: ${check.reason}\n`;
    case 'disabled':
      return undefined;
  }
}
