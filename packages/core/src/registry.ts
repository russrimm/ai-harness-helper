import type { ProviderDefinition } from './types.js';

/**
 * The provider registry: a declarative description of where every supported
 * agentic tool keeps its configuration.
 *
 * This file is intentionally *data*, not logic. Adding support for a new tool
 * means adding an entry here; the resolver, scanner, parsers, and UI all
 * derive their behaviour from these definitions.
 *
 * Path templates use `{token}` placeholders expanded by `paths.ts`:
 *   {home} {appData} {localAppData} {programData} {xdgConfig} {appSupport}
 *   {project}
 *
 * Entries marked "verified" were confirmed to exist on a real installation
 * during development. Unverified entries come from vendor documentation and
 * are reported as "not found" rather than as errors when absent.
 */
export const providers: readonly ProviderDefinition[] = [
  // ---------------------------------------------------------------------
  // Claude Code
  // ---------------------------------------------------------------------
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's terminal coding agent.",
    category: 'agent-cli',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/settings',
    locations: [
      {
        id: 'managed-settings',
        label: 'Managed (enterprise) settings',
        scope: 'managed',
        kind: 'settings',
        format: 'json',
        sensitivity: 'normal',
        note: 'Administrator policy. Overrides user and project settings.',
        paths: {
          win32: ['{programData}/ClaudeCode/managed-settings.json'],
          darwin: ['/Library/Application Support/ClaudeCode/managed-settings.json'],
          linux: ['/etc/claude-code/managed-settings.json'],
        },
      },
      {
        // verified: ~/.claude/settings.json
        id: 'user-settings',
        label: 'User settings',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.claude/settings.json'] },
      },
      {
        id: 'user-settings-local',
        label: 'User settings (local overrides)',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.claude/settings.local.json'] },
      },
      {
        // verified: ~/.claude.json
        id: 'global-state',
        label: 'Global state and per-project MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        note: 'Large file. Also holds cached telemetry and per-project history.',
        paths: { all: ['{home}/.claude.json'] },
      },
      {
        id: 'user-memory',
        label: 'User memory (CLAUDE.md)',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{home}/.claude/CLAUDE.md'] },
      },
      {
        id: 'user-agents',
        label: 'User subagents',
        scope: 'user',
        kind: 'agent',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.md'],
        paths: { all: ['{home}/.claude/agents'] },
      },
      {
        id: 'user-commands',
        label: 'User slash commands',
        scope: 'user',
        kind: 'command',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{home}/.claude/commands'] },
      },
      {
        // verified: ~/.claude/skills
        id: 'user-skills',
        label: 'User skills',
        scope: 'user',
        kind: 'skill',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/SKILL.md'],
        paths: { all: ['{home}/.claude/skills'] },
      },
      {
        // verified: ~/.claude/plugins
        id: 'user-plugins',
        label: 'Installed plugins',
        scope: 'user',
        kind: 'extension',
        format: 'json',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/.claude-plugin/plugin.json', 'config.json', 'known-marketplaces.json'],
        paths: { all: ['{home}/.claude/plugins'] },
      },
      {
        // verified: ~/.claude/.credentials.json
        id: 'credentials',
        label: 'Stored credentials',
        scope: 'user',
        kind: 'credential',
        format: 'json',
        sensitivity: 'credential-store',
        paths: { all: ['{home}/.claude/.credentials.json'] },
      },
      {
        id: 'project-settings',
        label: 'Project settings',
        scope: 'project',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.claude/settings.json'] },
      },
      {
        id: 'project-settings-local',
        label: 'Project settings (local, gitignored)',
        scope: 'project',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.claude/settings.local.json'] },
      },
      {
        id: 'project-mcp',
        label: 'Project MCP servers',
        scope: 'project',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.mcp.json'] },
      },
      {
        id: 'project-memory',
        label: 'Project memory (CLAUDE.md)',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{project}/CLAUDE.md', '{project}/.claude/CLAUDE.md'] },
      },
      {
        id: 'project-memory-local',
        label: 'Project memory (local, gitignored)',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        deprecated: true,
        note: 'Superseded by imports in CLAUDE.md.',
        paths: { all: ['{project}/CLAUDE.local.md'] },
      },
      {
        id: 'project-agents',
        label: 'Project subagents',
        scope: 'project',
        kind: 'agent',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.md'],
        paths: { all: ['{project}/.claude/agents'] },
      },
      {
        id: 'project-commands',
        label: 'Project slash commands',
        scope: 'project',
        kind: 'command',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{project}/.claude/commands'] },
      },
      {
        id: 'project-skills',
        label: 'Project skills',
        scope: 'project',
        kind: 'skill',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/SKILL.md'],
        paths: { all: ['{project}/.claude/skills'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Claude Desktop
  // ---------------------------------------------------------------------
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    description: 'Anthropic desktop application with MCP support.',
    category: 'desktop-app',
    docsUrl: 'https://modelcontextprotocol.io/quickstart/user',
    locations: [
      {
        // verified: %APPDATA%/Claude/claude_desktop_config.json
        id: 'desktop-config',
        label: 'Desktop MCP configuration',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: {
          win32: ['{appData}/Claude/claude_desktop_config.json'],
          darwin: ['{appSupport}/Claude/claude_desktop_config.json'],
          linux: ['{xdgConfig}/Claude/claude_desktop_config.json'],
        },
      },
      {
        id: 'desktop-extensions',
        label: 'Desktop extensions',
        scope: 'user',
        kind: 'extension',
        format: 'json',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/manifest.json'],
        paths: {
          win32: ['{appData}/Claude/Claude Extensions'],
          darwin: ['{appSupport}/Claude/Claude Extensions'],
          linux: ['{xdgConfig}/Claude/Claude Extensions'],
        },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // GitHub Copilot CLI
  // ---------------------------------------------------------------------
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    description: "GitHub's terminal coding agent.",
    category: 'agent-cli',
    docsUrl: 'https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli',
    locations: [
      {
        // verified: ~/.copilot/config.json (JSONC — contains comments)
        id: 'user-config',
        label: 'CLI configuration',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.copilot/config.json'] },
      },
      {
        id: 'user-settings',
        label: 'User settings',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.copilot/settings.json'] },
      },
      {
        id: 'user-mcp',
        label: 'MCP server configuration',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.copilot/mcp-config.json'] },
      },
      {
        // verified: ~/.copilot/copilot-instructions.md
        id: 'user-instructions',
        label: 'Personal instructions',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        note: 'Applied to every session in every repository, before any project instructions.',
        paths: { all: ['{home}/.copilot/copilot-instructions.md'] },
      },
      {
        // verified: ~/.copilot/permissions-config.json
        id: 'user-permissions',
        label: 'Saved tool permissions',
        scope: 'user',
        kind: 'permissions',
        format: 'json',
        sensitivity: 'normal',
        note: 'Approvals remembered per directory, so a rule you granted once keeps applying.',
        paths: { all: ['{home}/.copilot/permissions-config.json'] },
      },
      {
        // verified: ~/.copilot/agents/*.agent.md
        id: 'user-agents',
        label: 'Custom agents',
        scope: 'user',
        kind: 'agent',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.agent.md', '*.md'],
        paths: { all: ['{home}/.copilot/agents'] },
      },
      {
        // verified: ~/.copilot/skills
        id: 'user-skills',
        label: 'Skills',
        scope: 'user',
        kind: 'skill',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/SKILL.md', '*.md'],
        paths: { all: ['{home}/.copilot/skills'] },
      },
      {
        id: 'user-prompts',
        label: 'Prompt files',
        scope: 'user',
        kind: 'prompt',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.prompt.md', '*.md'],
        paths: { all: ['{home}/.copilot/prompts'] },
      },
      {
        // verified: ~/.copilot/installed-plugins
        id: 'user-plugins',
        label: 'Installed plugins',
        scope: 'user',
        kind: 'extension',
        format: 'json',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.json', '*/*.json'],
        paths: { all: ['{home}/.copilot/installed-plugins'] },
      },
      {
        // verified: %APPDATA%/GitHub Copilot in the CLI/config.yml
        id: 'legacy-cli-config',
        label: 'Legacy Copilot in the CLI configuration',
        scope: 'user',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        deprecated: true,
        note: 'Belongs to the older `gh copilot` extension, not the current CLI.',
        paths: {
          win32: ['{appData}/GitHub Copilot in the CLI/config.yml'],
          darwin: ['{home}/.config/github-copilot/config.yml'],
          linux: ['{xdgConfig}/github-copilot/config.yml'],
        },
      },
      {
        id: 'host-credentials',
        label: 'Copilot host credentials',
        scope: 'user',
        kind: 'credential',
        format: 'json',
        sensitivity: 'credential-store',
        paths: {
          win32: [
            '{localAppData}/github-copilot/apps.json',
            '{localAppData}/github-copilot/hosts.json',
          ],
          darwin: [
            '{home}/.config/github-copilot/apps.json',
            '{home}/.config/github-copilot/hosts.json',
          ],
          linux: ['{xdgConfig}/github-copilot/apps.json', '{xdgConfig}/github-copilot/hosts.json'],
        },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // GitHub Copilot in editors (repository-level customisation)
  // ---------------------------------------------------------------------
  {
    id: 'copilot-repo',
    name: 'GitHub Copilot (repository)',
    description: 'Repository-level Copilot customisation under .github/.',
    category: 'universal',
    docsUrl: 'https://docs.github.com/en/copilot/customizing-copilot',
    locations: [
      {
        id: 'repo-instructions',
        label: 'Repository custom instructions',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{project}/.github/copilot-instructions.md'] },
      },
      {
        id: 'path-instructions',
        label: 'Path-specific instructions',
        scope: 'project',
        kind: 'instructions',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.instructions.md'],
        paths: { all: ['{project}/.github/instructions'] },
      },
      {
        id: 'repo-prompts',
        label: 'Prompt files',
        scope: 'project',
        kind: 'prompt',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.prompt.md'],
        paths: { all: ['{project}/.github/prompts'] },
      },
      {
        id: 'repo-chatmodes',
        label: 'Custom chat modes',
        scope: 'project',
        kind: 'chatmode',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.chatmode.md'],
        paths: { all: ['{project}/.github/chatmodes'] },
      },
      {
        id: 'repo-agents',
        label: 'Custom agents',
        scope: 'project',
        kind: 'agent',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{project}/.github/agents'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Visual Studio Code
  // ---------------------------------------------------------------------
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    description: 'VS Code user and workspace configuration, including MCP servers.',
    category: 'editor',
    docsUrl: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    locations: [
      {
        // verified: %APPDATA%/Code/User/settings.json
        id: 'user-settings',
        label: 'User settings',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: {
          win32: [
            '{appData}/Code/User/settings.json',
            '{appData}/Code - Insiders/User/settings.json',
          ],
          darwin: [
            '{appSupport}/Code/User/settings.json',
            '{appSupport}/Code - Insiders/User/settings.json',
          ],
          linux: [
            '{xdgConfig}/Code/User/settings.json',
            '{xdgConfig}/Code - Insiders/User/settings.json',
          ],
        },
      },
      {
        // verified: %APPDATA%/Code/User/mcp.json
        id: 'user-mcp',
        label: 'User MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: {
          win32: ['{appData}/Code/User/mcp.json', '{appData}/Code - Insiders/User/mcp.json'],
          darwin: ['{appSupport}/Code/User/mcp.json', '{appSupport}/Code - Insiders/User/mcp.json'],
          linux: ['{xdgConfig}/Code/User/mcp.json', '{xdgConfig}/Code - Insiders/User/mcp.json'],
        },
      },
      {
        // verified: %APPDATA%/Code/User/prompts
        id: 'user-prompts',
        label: 'User prompts, instructions, and chat modes',
        scope: 'user',
        kind: 'prompt',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.prompt.md', '*.instructions.md', '*.chatmode.md', '*.toolsets.jsonc'],
        paths: {
          win32: ['{appData}/Code/User/prompts', '{appData}/Code - Insiders/User/prompts'],
          darwin: ['{appSupport}/Code/User/prompts', '{appSupport}/Code - Insiders/User/prompts'],
          linux: ['{xdgConfig}/Code/User/prompts', '{xdgConfig}/Code - Insiders/User/prompts'],
        },
      },
      {
        // verified: %APPDATA%/Code/User/profiles
        id: 'user-profiles',
        label: 'Profile settings and MCP servers',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        directory: true,
        patterns: ['*/settings.json', '*/mcp.json'],
        paths: {
          win32: ['{appData}/Code/User/profiles', '{appData}/Code - Insiders/User/profiles'],
          darwin: ['{appSupport}/Code/User/profiles', '{appSupport}/Code - Insiders/User/profiles'],
          linux: ['{xdgConfig}/Code/User/profiles', '{xdgConfig}/Code - Insiders/User/profiles'],
        },
      },
      {
        id: 'cline-mcp',
        label: 'Cline MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: {
          win32: [
            '{appData}/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          ],
          darwin: [
            '{appSupport}/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          ],
          linux: [
            '{xdgConfig}/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          ],
        },
      },
      {
        id: 'workspace-settings',
        label: 'Workspace settings',
        scope: 'project',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.vscode/settings.json'] },
      },
      {
        id: 'workspace-mcp',
        label: 'Workspace MCP servers',
        scope: 'project',
        kind: 'mcp',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.vscode/mcp.json'] },
      },
      {
        id: 'workspace-extensions',
        label: 'Recommended extensions',
        scope: 'project',
        kind: 'extension',
        format: 'jsonc',
        sensitivity: 'normal',
        paths: { all: ['{project}/.vscode/extensions.json'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Cursor
  // ---------------------------------------------------------------------
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'AI-first code editor with its own rules and MCP configuration.',
    category: 'editor',
    docsUrl: 'https://docs.cursor.com/context/rules',
    locations: [
      {
        id: 'user-mcp',
        label: 'Global MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.cursor/mcp.json'] },
      },
      {
        id: 'user-rules',
        label: 'Global rules',
        scope: 'user',
        kind: 'instructions',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.mdc', '**/*.md'],
        paths: { all: ['{home}/.cursor/rules'] },
      },
      {
        id: 'user-settings',
        label: 'Editor settings',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: {
          win32: ['{appData}/Cursor/User/settings.json'],
          darwin: ['{appSupport}/Cursor/User/settings.json'],
          linux: ['{xdgConfig}/Cursor/User/settings.json'],
        },
      },
      {
        id: 'project-mcp',
        label: 'Project MCP servers',
        scope: 'project',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.cursor/mcp.json'] },
      },
      {
        id: 'project-rules',
        label: 'Project rules',
        scope: 'project',
        kind: 'instructions',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.mdc', '**/*.md'],
        paths: { all: ['{project}/.cursor/rules'] },
      },
      {
        id: 'legacy-rules',
        label: 'Legacy .cursorrules',
        scope: 'project',
        kind: 'instructions',
        format: 'text',
        sensitivity: 'normal',
        deprecated: true,
        note: 'Superseded by .cursor/rules/*.mdc.',
        paths: { all: ['{project}/.cursorrules'] },
      },
      {
        id: 'ignore-files',
        label: 'Indexing and context ignore rules',
        scope: 'project',
        kind: 'ignore',
        format: 'text',
        sensitivity: 'normal',
        paths: { all: ['{project}/.cursorignore', '{project}/.cursorindexingignore'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // OpenAI Codex CLI
  // ---------------------------------------------------------------------
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    description: "OpenAI's terminal coding agent.",
    category: 'agent-cli',
    docsUrl: 'https://developers.openai.com/codex/local-config',
    locations: [
      {
        id: 'user-config',
        label: 'Codex configuration',
        scope: 'user',
        kind: 'settings',
        format: 'toml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.codex/config.toml'] },
      },
      {
        // verified: ~/.codex/mcp.json
        id: 'user-mcp',
        label: 'MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.codex/mcp.json'] },
      },
      {
        id: 'user-instructions',
        label: 'Global agent instructions',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{home}/.codex/AGENTS.md', '{home}/.codex/instructions.md'] },
      },
      {
        id: 'user-prompts',
        label: 'Custom prompts',
        scope: 'user',
        kind: 'prompt',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.md'],
        paths: { all: ['{home}/.codex/prompts'] },
      },
      {
        // verified: ~/.codex/skills
        id: 'user-skills',
        label: 'Skills',
        scope: 'user',
        kind: 'skill',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/SKILL.md', '*.md'],
        paths: { all: ['{home}/.codex/skills'] },
      },
      {
        // verified: ~/.codex/memories
        id: 'user-memories',
        label: 'Memories',
        scope: 'user',
        kind: 'memory',
        format: 'markdown',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{home}/.codex/memories'] },
      },
      {
        // verified: ~/.codex/auth.json
        id: 'auth',
        label: 'Stored credentials',
        scope: 'user',
        kind: 'credential',
        format: 'json',
        sensitivity: 'credential-store',
        paths: { all: ['{home}/.codex/auth.json'] },
      },
      {
        id: 'project-config',
        label: 'Project configuration',
        scope: 'project',
        kind: 'settings',
        format: 'toml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.codex/config.toml'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Windsurf / Codeium
  // ---------------------------------------------------------------------
  {
    id: 'windsurf',
    name: 'Windsurf (Codeium)',
    description: 'Windsurf editor and Codeium agent configuration.',
    category: 'editor',
    docsUrl: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    locations: [
      {
        id: 'user-mcp',
        label: 'MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.codeium/windsurf/mcp_config.json'] },
      },
      {
        id: 'user-memories',
        label: 'Cascade memories',
        scope: 'user',
        kind: 'memory',
        format: 'markdown',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{home}/.codeium/windsurf/memories'] },
      },
      {
        id: 'user-rules',
        label: 'Global rules',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{home}/.codeium/windsurf/memories/global_rules.md'] },
      },
      {
        id: 'project-rules',
        label: 'Workspace rules',
        scope: 'project',
        kind: 'instructions',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{project}/.windsurf/rules'] },
      },
      {
        id: 'legacy-rules',
        label: 'Legacy .windsurfrules',
        scope: 'project',
        kind: 'instructions',
        format: 'text',
        sensitivity: 'normal',
        deprecated: true,
        note: 'Superseded by .windsurf/rules/.',
        paths: { all: ['{project}/.windsurfrules'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Docker
  // ---------------------------------------------------------------------
  {
    id: 'docker',
    name: 'Docker',
    description: 'Docker CLI configuration and the Docker MCP Toolkit gateway.',
    category: 'runtime',
    docsUrl: 'https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/',
    locations: [
      {
        // verified: ~/.docker/config.json
        id: 'cli-config',
        label: 'Docker CLI configuration',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'credential-store',
        note: 'Contains registry authentication material in `auths`.',
        paths: { all: ['{home}/.docker/config.json'] },
      },
      {
        // verified: ~/.docker/daemon.json
        id: 'daemon-config',
        label: 'Daemon configuration',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'normal',
        paths: { all: ['{home}/.docker/daemon.json', '{home}/.docker/windows-daemon.json'] },
      },
      {
        // verified: ~/.docker/mcp/registry.yaml
        id: 'mcp-registry',
        label: 'MCP Toolkit enabled servers',
        scope: 'user',
        kind: 'mcp',
        format: 'yaml',
        sensitivity: 'normal',
        paths: { all: ['{home}/.docker/mcp/registry.yaml'] },
      },
      {
        // verified: ~/.docker/mcp/config.yaml
        id: 'mcp-config',
        label: 'MCP Toolkit server configuration',
        scope: 'user',
        kind: 'mcp',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.docker/mcp/config.yaml'] },
      },
      {
        // verified: ~/.docker/mcp/tools.yaml
        id: 'mcp-tools',
        label: 'MCP Toolkit tool allowlist',
        scope: 'user',
        kind: 'permissions',
        format: 'yaml',
        sensitivity: 'normal',
        paths: { all: ['{home}/.docker/mcp/tools.yaml'] },
      },
      {
        // verified: ~/.docker/mcp/catalogs
        id: 'mcp-catalogs',
        label: 'MCP Toolkit catalogs',
        scope: 'user',
        kind: 'catalog',
        format: 'yaml',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.yaml', '*.yml', '*.json'],
        note: 'Lists every server Docker offers, not the ones you have enabled. Enabled servers live in registry.yaml.',
        paths: { all: ['{home}/.docker/mcp/catalogs'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Gemini CLI
  // ---------------------------------------------------------------------
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    description: "Google's terminal coding agent.",
    category: 'agent-cli',
    docsUrl: 'https://google-gemini.github.io/gemini-cli/docs/cli/configuration.html',
    locations: [
      {
        id: 'user-settings',
        label: 'User settings',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        note: 'MCP servers are declared under `mcpServers`.',
        paths: { all: ['{home}/.gemini/settings.json'] },
      },
      {
        id: 'user-instructions',
        label: 'Global context (GEMINI.md)',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{home}/.gemini/GEMINI.md'] },
      },
      {
        id: 'user-extensions',
        label: 'Extensions',
        scope: 'user',
        kind: 'extension',
        format: 'json',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*/gemini-extension.json'],
        paths: { all: ['{home}/.gemini/extensions'] },
      },
      {
        id: 'project-settings',
        label: 'Project settings',
        scope: 'project',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.gemini/settings.json'] },
      },
      {
        id: 'project-instructions',
        label: 'Project context (GEMINI.md)',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{project}/GEMINI.md'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Continue
  // ---------------------------------------------------------------------
  {
    id: 'continue',
    name: 'Continue',
    description: 'Open-source IDE assistant with YAML/JSON assistant configuration.',
    category: 'editor',
    docsUrl: 'https://docs.continue.dev/reference',
    locations: [
      {
        id: 'user-config',
        label: 'Global configuration',
        scope: 'user',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.continue/config.yaml'] },
      },
      {
        id: 'user-config-legacy',
        label: 'Legacy JSON configuration',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        deprecated: true,
        paths: { all: ['{home}/.continue/config.json'] },
      },
      {
        id: 'user-mcp',
        label: 'MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        directory: true,
        patterns: ['*.yaml', '*.yml'],
        paths: { all: ['{home}/.continue/mcpServers'] },
      },
      {
        id: 'user-rules',
        label: 'Rules',
        scope: 'user',
        kind: 'instructions',
        format: 'md-frontmatter',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{home}/.continue/rules'] },
      },
      {
        id: 'project-config',
        label: 'Project configuration',
        scope: 'project',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.continue/config.yaml'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Roo Code
  // ---------------------------------------------------------------------
  {
    id: 'roo-code',
    name: 'Roo Code',
    description: 'VS Code agent with custom modes and MCP servers.',
    category: 'editor',
    docsUrl: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
    locations: [
      {
        id: 'project-modes',
        label: 'Custom modes',
        scope: 'project',
        kind: 'agent',
        format: 'yaml',
        sensitivity: 'normal',
        paths: { all: ['{project}/.roomodes'] },
      },
      {
        id: 'project-mcp',
        label: 'Project MCP servers',
        scope: 'project',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.roo/mcp.json'] },
      },
      {
        id: 'project-rules',
        label: 'Project rules',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{project}/.roo/rules'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Aider
  // ---------------------------------------------------------------------
  {
    id: 'aider',
    name: 'Aider',
    description: 'Terminal pair-programming tool configured through YAML.',
    category: 'agent-cli',
    docsUrl: 'https://aider.chat/docs/config/aider_conf.html',
    locations: [
      {
        id: 'user-config',
        label: 'User configuration',
        scope: 'user',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.aider.conf.yml'] },
      },
      {
        id: 'user-model-settings',
        label: 'Model settings',
        scope: 'user',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'normal',
        paths: { all: ['{home}/.aider.model.settings.yml'] },
      },
      {
        id: 'project-config',
        label: 'Project configuration',
        scope: 'project',
        kind: 'settings',
        format: 'yaml',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.aider.conf.yml'] },
      },
      {
        id: 'project-conventions',
        label: 'Conventions',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{project}/CONVENTIONS.md'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Zed
  // ---------------------------------------------------------------------
  {
    id: 'zed',
    name: 'Zed',
    description: 'Zed editor settings, including context servers.',
    category: 'editor',
    docsUrl: 'https://zed.dev/docs/configuring-zed',
    locations: [
      {
        id: 'user-settings',
        label: 'User settings',
        scope: 'user',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        note: 'MCP servers are declared under `context_servers`.',
        paths: {
          win32: ['{appData}/Zed/settings.json'],
          darwin: ['{home}/.config/zed/settings.json'],
          linux: ['{xdgConfig}/zed/settings.json'],
        },
      },
      {
        id: 'project-settings',
        label: 'Project settings',
        scope: 'project',
        kind: 'settings',
        format: 'jsonc',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.zed/settings.json'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Amazon Q Developer
  // ---------------------------------------------------------------------
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    description: 'AWS coding assistant with MCP and rules support.',
    category: 'agent-cli',
    docsUrl: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp.html',
    locations: [
      {
        id: 'user-mcp',
        label: 'Global MCP servers',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.aws/amazonq/mcp.json'] },
      },
      {
        id: 'user-agents',
        label: 'Custom agents',
        scope: 'user',
        kind: 'agent',
        format: 'json',
        sensitivity: 'normal',
        directory: true,
        patterns: ['*.json'],
        paths: { all: ['{home}/.aws/amazonq/cli-agents'] },
      },
      {
        id: 'project-mcp',
        label: 'Project MCP servers',
        scope: 'project',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/.amazonq/mcp.json'] },
      },
      {
        id: 'project-rules',
        label: 'Project rules',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        directory: true,
        patterns: ['**/*.md'],
        paths: { all: ['{project}/.amazonq/rules'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // OpenCode
  // ---------------------------------------------------------------------
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source terminal agent.',
    category: 'agent-cli',
    docsUrl: 'https://opencode.ai/docs/config/',
    locations: [
      {
        id: 'user-config',
        label: 'Global configuration',
        scope: 'user',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: {
          win32: ['{appData}/opencode/opencode.json', '{home}/.config/opencode/opencode.json'],
          darwin: ['{home}/.config/opencode/opencode.json'],
          linux: ['{xdgConfig}/opencode/opencode.json'],
        },
      },
      {
        id: 'user-instructions',
        label: 'Global instructions',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: {
          win32: ['{appData}/opencode/AGENTS.md', '{home}/.config/opencode/AGENTS.md'],
          darwin: ['{home}/.config/opencode/AGENTS.md'],
          linux: ['{xdgConfig}/opencode/AGENTS.md'],
        },
      },
      {
        id: 'project-config',
        label: 'Project configuration',
        scope: 'project',
        kind: 'settings',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{project}/opencode.json', '{project}/opencode.jsonc'] },
      },
    ],
  },

  // ---------------------------------------------------------------------
  // Cross-tool conventions
  // ---------------------------------------------------------------------
  {
    id: 'universal',
    name: 'Cross-tool conventions',
    description: 'Files that many agents read regardless of vendor.',
    category: 'universal',
    docsUrl: 'https://agents.md/',
    locations: [
      {
        id: 'agents-md',
        label: 'AGENTS.md',
        scope: 'project',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        note: 'Read by Codex, OpenCode, Copilot, Jules, and others.',
        paths: { all: ['{project}/AGENTS.md'] },
      },
      {
        id: 'agents-md-user',
        label: 'AGENTS.md (home directory)',
        scope: 'user',
        kind: 'instructions',
        format: 'markdown',
        sensitivity: 'normal',
        paths: { all: ['{home}/AGENTS.md'] },
      },
      {
        id: 'mcp-json-user',
        label: 'Stray MCP configuration in home directory',
        scope: 'user',
        kind: 'mcp',
        format: 'json',
        sensitivity: 'contains-secrets',
        paths: { all: ['{home}/.mcp.json', '{home}/mcp.json'] },
      },
      {
        id: 'aiignore',
        label: 'AI ignore rules',
        scope: 'project',
        kind: 'ignore',
        format: 'text',
        sensitivity: 'normal',
        paths: { all: ['{project}/.aiignore', '{project}/.aiexclude', '{project}/.codeiumignore'] },
      },
    ],
  },
];

/** Fast lookup of a provider by its identifier. */
export const providersById: ReadonlyMap<string, ProviderDefinition> = new Map(
  providers.map((provider) => [provider.id, provider]),
);

/** Every location paired with the provider that owns it. */
export function allLocations(): Array<{
  provider: ProviderDefinition;
  location: ProviderDefinition['locations'][number];
}> {
  return providers.flatMap((provider) =>
    provider.locations.map((location) => ({ provider, location })),
  );
}
