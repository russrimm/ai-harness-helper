/**
 * Functional overlap between *differently named* MCP servers.
 *
 * The duplicate/conflict analysis in `aggregate.ts` answers "is this one name
 * declared twice?". That misses the more common and more expensive problem:
 * three separately named servers that all do the same job, each one burning
 * context window on tool descriptions the model will never use.
 *
 * Nothing here executes a server or reaches the network — a server's
 * capabilities are inferred entirely from what its declaration already says.
 * Because that inference ranges from certain (two names, one identical launch
 * command) to suggestive (two names that both look like web search), every
 * group carries the evidence that produced it and a confidence level, and the
 * UI shows both. A finding the user cannot audit is a finding they cannot act
 * on.
 */

import type { McpDefinition, McpServerEntry } from './aggregate.js';

/** What kind of evidence links the members of an overlap group. */
export type McpOverlapKind =
  /** Identical normalized launch command or endpoint. */
  | 'same-target'
  /** Same underlying package, image, or executable. */
  | 'same-package'
  /** Same remote URL, path included. */
  | 'same-endpoint'
  /** Same remote host, different paths. */
  | 'same-host'
  /** Names and packages that describe the same capability area. */
  | 'shared-domain';

/** How much weight the evidence carries. */
export type McpOverlapConfidence = 'high' | 'medium' | 'low';

/** One server's participation in an overlap group. */
export interface McpOverlapMember {
  readonly serverName: string;
  /** Tools that declare this server. */
  readonly providerIds: readonly string[];
  readonly providerNames: readonly string[];
  /** Files the declarations live in, for a direct jump to the source. */
  readonly fileIds: readonly string[];
  readonly displayPaths: readonly string[];
  /** The specific text that matched, e.g. `npx @scope/server-github`. */
  readonly evidence: string;
  /** True when every declaration of this server is disabled. */
  readonly disabled: boolean;
}

/** Two or more differently named servers that appear to do the same job. */
export interface McpOverlapGroup {
  readonly id: string;
  readonly kind: McpOverlapKind;
  readonly confidence: McpOverlapConfidence;
  /** Short human label for what the members share. */
  readonly label: string;
  /** The normalized value the members were grouped on. */
  readonly sharedKey: string;
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly serverNames: readonly string[];
  readonly members: readonly McpOverlapMember[];
  readonly fileIds: readonly string[];
  readonly displayPaths: readonly string[];
}

/* ------------------------------------------------------ Package identity -- */

/** Commands that run a package rather than being one. */
const NPM_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'bun']);
const PYTHON_RUNNERS = new Set(['uvx', 'uv', 'pipx']);
const CONTAINER_RUNNERS = new Set(['docker', 'podman', 'nerdctl']);
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'deno', 'dotnet', 'java', 'ruby']);

/** Sub-commands a runner takes before the package name appears. */
const RUNNER_SUBCOMMANDS = new Set([
  'exec',
  'dlx',
  'run',
  'x',
  'tool',
  'create',
  'install',
  '--package',
]);

/**
 * Container flags that consume the following argument.
 *
 * Without this list `docker run -e TOKEN ghcr.io/x/y` would read `TOKEN` as
 * the image name, and every server that happens to pass `-e` would look
 * identical to every other.
 */
const CONTAINER_VALUE_FLAGS = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '--mount',
  '-p',
  '--publish',
  '--name',
  '-w',
  '--workdir',
  '--network',
  '--net',
  '-u',
  '--user',
  '--entrypoint',
  '--label',
  '-l',
  '--platform',
  '--add-host',
  '--device',
  '--memory',
  '-m',
  '--cpus',
  '--pull',
  '--restart',
]);

/**
 * Tokens that say "this is an MCP server" rather than what it does.
 *
 * Stripping them is what lets `@modelcontextprotocol/server-github` and
 * `github-mcp-server` resolve to the same component.
 */
const NOISE_TOKENS = new Set([
  'mcp',
  'mcps',
  'server',
  'servers',
  'mcpserver',
  'mcpservers',
  'modelcontextprotocol',
]);

/** Splits an identifier into lowercase alphanumeric tokens. */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

/** Strips directory and extension so `npx` and `/usr/bin/npx.cmd` match. */
function commandBase(command: string | undefined): string {
  if (!command) return '';
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Strips a reverse-DNS registry namespace.
 *
 * MCP registry ids look like `io.github.upstash/context7` and Docker catalog
 * entries like `com.microsoft/azure`. The `io.github` prefix says who published
 * the server, not what it does — and left in place it makes every registry
 * entry on the machine look like a GitHub server.
 */
function stripRegistryNamespace(value: string): string {
  return value.replace(/^(?:io|com|net|org|dev|app|ai|me|co)\.[a-z0-9-]+[./]/i, '');
}

/**
 * Pulls the meaningful tail out of a catalog locator.
 *
 * Docker's MCP Toolkit references entries as
 * `github:docker/labs-ai-tools-for-devs?ref=main&path=prompts/mcp/fetch.md`.
 * Tokenizing that whole string describes the repository that hosts the
 * catalog, which every entry shares, instead of the server it points at.
 */
function locatorTail(value: string): string {
  const query = value.indexOf('?');
  if (query === -1) return value;

  const params = value.slice(query + 1);
  const path = /(?:^|&)path=([^&]+)/.exec(params)?.[1];
  const base = path ? decodeURIComponent(path) : value.slice(0, query);
  const segment = base.split('/').filter(Boolean).pop() ?? base;
  return segment.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/**
 * Reduces a package specifier to the capability it names.
 *
 * `@modelcontextprotocol/server-github`, `github-mcp-server`, and
 * `ghcr.io/github/github-mcp-server` all become `github`. When stripping the
 * noise leaves nothing — `@playwright/mcp`, `docker.io/mcp/server` — the
 * preceding segment is used instead, because that is where the meaning went.
 */
export function packageComponent(specifier: string): string {
  const withoutProtocol = specifier.replace(/^(npm|jsr|pypi|oci|bin|ref|script):/, '');
  const located = stripRegistryNamespace(locatorTail(withoutProtocol));

  const scoped = /^@([^/]+)\/(.+)$/.exec(located);
  const segments = scoped ? [scoped[1]!, scoped[2]!] : located.split('/').filter(Boolean);
  // An image's registry host (`ghcr.io`, `mcr.microsoft.com`) is packaging,
  // not capability, so only the name and its immediate owner are considered.
  const meaningfulSegments = segments.slice(-2);
  const bare = meaningfulSegments[meaningfulSegments.length - 1] ?? located;
  const owner = meaningfulSegments.length > 1 ? meaningfulSegments[0] : undefined;

  const meaningful = tokenize(bare).filter((token) => !NOISE_TOKENS.has(token));
  if (meaningful.length > 0) return meaningful.join('-');

  if (owner) {
    const ownerTokens = tokenize(owner).filter((token) => !NOISE_TOKENS.has(token));
    if (ownerTokens.length > 0) return ownerTokens.join('-');
  }

  return tokenize(bare).join('-');
}

/** Drops an npm version range or a container tag/digest from a specifier. */
function stripVersion(specifier: string): string {
  const withoutDigest = specifier.split('@sha256:')[0] ?? specifier;
  const scoped = /^(@[^/]+\/[^@]+)@.+$/.exec(withoutDigest);
  if (scoped?.[1]) return scoped[1];
  if (!withoutDigest.startsWith('@')) {
    const at = withoutDigest.indexOf('@');
    if (at > 0) return withoutDigest.slice(0, at);
  }
  return withoutDigest;
}

/** Removes a container image tag without mangling a registry port. */
function stripImageTag(image: string): string {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(0, colon) : image;
}

/** First argument that is not a flag, skipping known sub-commands. */
function firstPositional(args: readonly string[], skip: ReadonlySet<string>): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (skip.has(arg.toLowerCase())) continue;
    return arg;
  }
  return undefined;
}

/**
 * Names the package, image, or executable a definition actually launches.
 *
 * Returns an ecosystem-qualified id so `npm:x` and `pypi:x` stay
 * distinguishable in the evidence shown to the user, even though grouping is
 * done on the component derived from it.
 */
export function packageIdentity(definition: McpDefinition): string | undefined {
  if (definition.reference) return `ref:${stripVersion(definition.reference)}`;

  const command = commandBase(definition.command);
  if (!command) return undefined;
  const args = definition.args ?? [];

  if (NPM_RUNNERS.has(command)) {
    const spec = firstPositional(args, RUNNER_SUBCOMMANDS);
    if (!spec) return undefined;
    const cleaned = stripVersion(spec.replace(/^npm:/, ''));
    return cleaned.length > 0 ? `npm:${cleaned}` : undefined;
  }

  if (PYTHON_RUNNERS.has(command)) {
    const spec = firstPositional(args, RUNNER_SUBCOMMANDS);
    if (!spec) return undefined;
    const cleaned = stripVersion(spec).replace(/[<>=!~].*$/, '');
    return cleaned.length > 0 ? `pypi:${cleaned}` : undefined;
  }

  if (CONTAINER_RUNNERS.has(command)) {
    const image = containerImage(args);
    return image ? `oci:${stripImageTag(image)}` : undefined;
  }

  if (SCRIPT_RUNNERS.has(command)) {
    const target = firstPositional(args, RUNNER_SUBCOMMANDS);
    if (!target) return undefined;
    const base = target.split(/[\\/]/).pop() ?? target;
    // A bare `index.js` says nothing about what the server does.
    if (/^(index|main|server|app|start|cli|__main__)\.\w+$/i.test(base)) return undefined;
    return `script:${stripVersion(base)}`;
  }

  return `bin:${command}`;
}

/** Sub-commands that precede the image in a container invocation. */
const CONTAINER_SUBCOMMANDS = new Set(['run', 'create', 'container', 'exec', 'start']);

/** Extracts the image from a container argument vector. */
function containerImage(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('-')) {
      // Skipping the value keeps `docker run -e TOKEN image` from reading
      // `TOKEN` as the image, which would make every `-e` server look alike.
      if (CONTAINER_VALUE_FLAGS.has(arg) && !arg.includes('=')) index += 1;
      continue;
    }
    if (CONTAINER_SUBCOMMANDS.has(arg)) continue;
    return arg;
  }
  return undefined;
}

/* ------------------------------------------------------ Capability areas -- */

interface DomainDefinition {
  readonly id: string;
  readonly label: string;
  /** Whole tokens that identify the area. */
  readonly tokens?: readonly string[];
  /** Substrings matched against the hyphen-joined token string. */
  readonly phrases?: readonly string[];
}

/**
 * Capability areas, keyed by the vocabulary servers in them actually use.
 *
 * Deliberately conservative and deliberately not exhaustive: a missed overlap
 * costs the user nothing, whereas a domain broad enough to sweep unrelated
 * servers together would make the whole panel untrustworthy. Matching is on
 * whole tokens, so `git` never matches `github`.
 */
const DOMAINS: readonly DomainDefinition[] = [
  {
    id: 'browser-automation',
    label: 'Browser automation',
    tokens: ['playwright', 'puppeteer', 'browserbase', 'selenium', 'stagehand', 'browserless'],
    phrases: ['browser-use', 'chrome-devtools', 'browser-tools'],
  },
  {
    id: 'web-search',
    label: 'Web search',
    tokens: ['brave', 'tavily', 'exa', 'perplexity', 'serper', 'serpapi', 'duckduckgo', 'kagi'],
    phrases: ['web-search', 'google-search', 'searxng'],
  },
  {
    id: 'web-fetch',
    label: 'Web page retrieval',
    tokens: ['fetch', 'fetcher', 'firecrawl', 'crawl4ai', 'jina', 'scrape', 'scraper', 'crawler'],
    phrases: ['web-fetch', 'markdownify'],
  },
  { id: 'github', label: 'GitHub', tokens: ['github'] },
  { id: 'gitlab', label: 'GitLab', tokens: ['gitlab'] },
  { id: 'git', label: 'Git repositories', tokens: ['git'] },
  {
    id: 'filesystem',
    label: 'Local filesystem',
    tokens: ['filesystem', 'files'],
    phrases: ['desktop-commander', 'file-system'],
  },
  { id: 'postgres', label: 'PostgreSQL', tokens: ['postgres', 'postgresql', 'supabase', 'neon'] },
  { id: 'mysql', label: 'MySQL', tokens: ['mysql', 'mariadb'] },
  { id: 'sqlite', label: 'SQLite', tokens: ['sqlite'] },
  { id: 'mongodb', label: 'MongoDB', tokens: ['mongo', 'mongodb'] },
  {
    id: 'issue-tracking',
    label: 'Issue tracking',
    tokens: ['jira', 'linear', 'asana', 'shortcut', 'trello', 'clickup', 'youtrack'],
  },
  {
    id: 'memory',
    label: 'Long-term memory',
    tokens: ['memory', 'mem0', 'zep'],
    phrases: ['knowledge-graph', 'basic-memory'],
  },
  {
    id: 'documentation',
    label: 'Documentation lookup',
    tokens: ['context7', 'docs', 'documentation', 'devdocs'],
    phrases: ['microsoft-learn', 'aws-documentation'],
  },
  { id: 'slack', label: 'Slack', tokens: ['slack'] },
  { id: 'notion', label: 'Notion', tokens: ['notion'] },
  { id: 'aws', label: 'AWS', tokens: ['aws'] },
  { id: 'azure', label: 'Azure', tokens: ['azure'] },
  { id: 'gcp', label: 'Google Cloud', tokens: ['gcp'], phrases: ['google-cloud'] },
  { id: 'kubernetes', label: 'Kubernetes', tokens: ['kubernetes', 'k8s', 'kubectl', 'helm'] },
  {
    id: 'observability',
    label: 'Observability',
    tokens: ['sentry', 'grafana', 'datadog', 'honeycomb', 'newrelic', 'prometheus'],
  },
  { id: 'payments', label: 'Payments', tokens: ['stripe', 'paypal'] },
  { id: 'email', label: 'Email', tokens: ['gmail', 'sendgrid', 'resend', 'mailgun', 'postmark'] },
  { id: 'time', label: 'Time and time zones', tokens: ['time', 'datetime', 'timezone'] },
  {
    id: 'reasoning',
    label: 'Structured reasoning',
    tokens: ['sequentialthinking', 'thinking'],
    phrases: ['sequential-thinking', 'clear-thought'],
  },
  { id: 'figma', label: 'Figma', tokens: ['figma'] },
  { id: 'calendar', label: 'Calendars', tokens: ['calendar', 'gcal'] },
];

/** Domains a set of descriptive tokens places a server in. */
function domainsFor(tokens: readonly string[]): DomainDefinition[] {
  const set = new Set(tokens);
  const joined = tokens.join('-');
  return DOMAINS.filter((domain) => {
    if (domain.tokens?.some((token) => set.has(token))) return true;
    return domain.phrases?.some((phrase) => joined.includes(phrase)) ?? false;
  });
}

/* --------------------------------------------------------------- Facts --- */

interface ServerFacts {
  readonly entry: McpServerEntry;
  /** Launch signatures, one per definition, empty ones excluded. */
  readonly signatures: ReadonlyMap<string, McpDefinition>;
  readonly packages: ReadonlyMap<string, McpDefinition>;
  /** Package components, mapped to the identity that produced them. */
  readonly components: ReadonlyMap<string, string>;
  readonly endpoints: ReadonlyMap<string, McpDefinition>;
  readonly hosts: ReadonlyMap<string, McpDefinition>;
  readonly tokens: readonly string[];
  readonly disabled: boolean;
}

/** True when a definition names something concrete enough to compare. */
function isAddressable(definition: McpDefinition): boolean {
  return Boolean(definition.command ?? definition.url ?? definition.reference);
}

function endpointOf(url: string): { endpoint: string; host: string } | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return {
      endpoint: `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`,
      host: parsed.host.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

function factsFor(entry: McpServerEntry): ServerFacts {
  const signatures = new Map<string, McpDefinition>();
  const packages = new Map<string, McpDefinition>();
  const components = new Map<string, string>();
  const endpoints = new Map<string, McpDefinition>();
  const hosts = new Map<string, McpDefinition>();
  const tokens = new Set(tokenize(stripRegistryNamespace(entry.name)));

  for (const definition of entry.definitions) {
    if (!isAddressable(definition)) continue;

    if (definition.signature.length > 0) {
      if (!signatures.has(definition.signature)) signatures.set(definition.signature, definition);
    }

    const identity = packageIdentity(definition);
    if (identity) {
      if (!packages.has(identity)) packages.set(identity, definition);
      const component = packageComponent(identity);
      if (component.length > 0) {
        if (!components.has(component)) components.set(component, identity);
        for (const token of tokenize(component)) tokens.add(token);
      }
    }

    if (definition.url) {
      const parsed = endpointOf(definition.url);
      if (parsed) {
        if (!endpoints.has(parsed.endpoint)) endpoints.set(parsed.endpoint, definition);
        if (!hosts.has(parsed.host)) hosts.set(parsed.host, definition);
        // The host carries meaning too: `mcp.notion.com` says "Notion".
        for (const label of parsed.host.split('.')) {
          if (label.length > 2 && !/^(www|api|mcp|com|net|org|io|dev|app|ai)$/.test(label)) {
            tokens.add(label);
          }
        }
      }
    }
  }

  return {
    entry,
    signatures,
    packages,
    components,
    endpoints,
    hosts,
    tokens: [...tokens],
    disabled: entry.definitions.length > 0 && entry.definitions.every((d) => d.disabled),
  };
}

/* -------------------------------------------------------------- Grouping -- */

interface Candidate {
  readonly kind: McpOverlapKind;
  readonly confidence: McpOverlapConfidence;
  readonly key: string;
  readonly label: string;
  readonly members: readonly { facts: ServerFacts; evidence: string }[];
}

const CONFIDENCE_RANK: Record<McpOverlapConfidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * Tiebreak within a confidence level, strongest explanation first.
 *
 * Two servers running one package are also, necessarily, two servers with the
 * same launch command; both candidates are "high". Ranking the kinds decides
 * which of the two the user is shown, and "these launch identically" is more
 * specific — and more obviously actionable — than "these share a package".
 */
const KIND_RANK: Record<McpOverlapKind, number> = {
  'same-target': 5,
  'same-endpoint': 4,
  'same-package': 3,
  'same-host': 2,
  'shared-domain': 1,
};

function describeDefinition(definition: McpDefinition): string {
  if (definition.url) return definition.url;
  if (definition.command) {
    return `${definition.command} ${(definition.args ?? []).join(' ')}`.trim();
  }
  return definition.reference ?? definition.transport;
}

/**
 * Collects servers that share a key produced by `keysOf`.
 *
 * Only groups spanning two or more *distinct names* are returned; a single
 * name declared twice is a duplicate, which the inventory already reports.
 */
function groupBy(
  servers: readonly ServerFacts[],
  kind: McpOverlapKind,
  confidence: McpOverlapConfidence,
  keysOf: (facts: ServerFacts) => Iterable<[key: string, label: string, evidence: string]>,
): Candidate[] {
  const buckets = new Map<
    string,
    { label: string; members: { facts: ServerFacts; evidence: string }[] }
  >();

  for (const facts of servers) {
    const seen = new Set<string>();
    for (const [key, label, evidence] of keysOf(facts)) {
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const bucket = buckets.get(key);
      if (bucket) bucket.members.push({ facts, evidence });
      else buckets.set(key, { label, members: [{ facts, evidence }] });
    }
  }

  const candidates: Candidate[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.members.length < 2) continue;
    candidates.push({ kind, confidence, key, label: bucket.label, members: bucket.members });
  }
  return candidates;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function titleFor(candidate: Candidate, names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`).join(', ');
  switch (candidate.kind) {
    case 'same-target':
      return `${list} launch the same server`;
    case 'same-package':
      return `${list} run the same package`;
    case 'same-endpoint':
      return `${list} point at the same endpoint`;
    case 'same-host':
      return `${list} point at the same host`;
    case 'shared-domain':
      return `${list} all cover ${candidate.label.toLowerCase()}`;
  }
}

function detailFor(candidate: Candidate, names: readonly string[]): string {
  switch (candidate.kind) {
    case 'same-target':
      return `${names.length} differently named servers resolve to exactly the same launch target (${candidate.key}). Each one is started separately, so the same tools are registered ${names.length} times.`;
    case 'same-package':
      return `${names.length} differently named servers are built from ${candidate.label}. They almost certainly expose the same tools.`;
    case 'same-endpoint':
      return `${names.length} differently named servers connect to ${candidate.key}, so the same remote server is registered more than once.`;
    case 'same-host':
      return `${names.length} differently named servers connect to ${candidate.key} on different paths. They may be different surfaces of one product, or the same one reached two ways.`;
    case 'shared-domain':
      return `${names.length} servers look like they cover ${candidate.label.toLowerCase()}. This is inferred from their names and packages, not from their tool lists, so confirm before removing anything.`;
  }
}

function remediationFor(kind: McpOverlapKind): string {
  switch (kind) {
    case 'same-target':
    case 'same-endpoint':
      return 'Keep one and delete the rest — the duplicates add tool definitions to every request without adding capability.';
    case 'same-package':
      return 'Keep whichever declaration is configured the way you want, and delete the others.';
    case 'same-host':
      return 'Check whether the two paths really expose different tools. If they do not, keep one.';
    case 'shared-domain':
      return 'Compare the tools each server exposes and keep the one that covers what you need.';
  }
}

/**
 * Finds functional overlap across every MCP server in the inventory.
 *
 * Results are ordered strongest evidence first, and a weaker group is dropped
 * when every pair of servers in it is already explained by a stronger one — so
 * "these two run the same package" is never restated as "these two both look
 * like GitHub servers".
 */
export function detectMcpOverlaps(entries: readonly McpServerEntry[]): McpOverlapGroup[] {
  const servers = entries.map(factsFor);

  const candidates: Candidate[] = [
    ...groupBy(servers, 'same-target', 'high', function* (facts) {
      for (const [signature, definition] of facts.signatures) {
        yield [signature, signature, describeDefinition(definition)];
      }
    }),
    ...groupBy(servers, 'same-package', 'high', function* (facts) {
      for (const [component, identity] of facts.components) {
        yield [component, identity, identity];
      }
    }),
    ...groupBy(servers, 'same-endpoint', 'high', function* (facts) {
      for (const endpoint of facts.endpoints.keys()) {
        yield [endpoint, endpoint, endpoint];
      }
    }),
    ...groupBy(servers, 'same-host', 'medium', function* (facts) {
      for (const [host, definition] of facts.hosts) {
        yield [host, host, definition.url ?? host];
      }
    }),
    ...groupBy(servers, 'shared-domain', 'low', function* (facts) {
      for (const domain of domainsFor(facts.tokens)) {
        const identity = [...facts.components.values()][0];
        yield [domain.id, domain.label, identity ?? facts.entry.name];
      }
    }),
  ];

  candidates.sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      KIND_RANK[b.kind] - KIND_RANK[a.kind] ||
      b.members.length - a.members.length ||
      a.key.localeCompare(b.key),
  );

  const explained = new Set<string>();
  const groups: McpOverlapGroup[] = [];

  for (const candidate of candidates) {
    // One server can reach a bucket through several definitions; collapse to
    // one member per name before deciding whether the group is interesting.
    const byName = new Map<string, { facts: ServerFacts; evidence: string }>();
    for (const member of candidate.members) {
      if (!byName.has(member.facts.entry.name)) byName.set(member.facts.entry.name, member);
    }
    if (byName.size < 2) continue;

    const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
    const pairs: string[] = [];
    let novel = false;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const pair = pairKey(names[i]!, names[j]!);
        pairs.push(pair);
        if (!explained.has(pair)) novel = true;
      }
    }
    if (!novel) continue;
    for (const pair of pairs) explained.add(pair);

    const members: McpOverlapMember[] = names.map((name) => {
      const { facts, evidence } = byName.get(name)!;
      return {
        serverName: name,
        providerIds: [...facts.entry.providerIds],
        providerNames: [...new Set(facts.entry.definitions.map((d) => d.providerName))].sort(),
        fileIds: [...new Set(facts.entry.definitions.map((d) => d.fileId))],
        displayPaths: [...new Set(facts.entry.definitions.map((d) => d.displayPath))],
        evidence,
        disabled: facts.disabled,
      };
    });

    groups.push({
      id: `mcp-overlap:${candidate.kind}:${candidate.key}`,
      kind: candidate.kind,
      confidence: candidate.confidence,
      label: candidate.label,
      sharedKey: candidate.key,
      title: titleFor(candidate, names),
      detail: detailFor(candidate, names),
      remediation: remediationFor(candidate.kind),
      serverNames: names,
      members,
      fileIds: [...new Set(members.flatMap((member) => member.fileIds))],
      displayPaths: [...new Set(members.flatMap((member) => member.displayPaths))],
    });
  }

  return groups;
}
