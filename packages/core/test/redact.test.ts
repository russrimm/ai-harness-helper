import { describe, expect, it } from 'vitest';
import {
  detectSecretValue,
  isSecretKey,
  maskValue,
  redactText,
  redactValue,
  resolveRedactionPath,
} from '../src/redact.js';

describe('isSecretKey', () => {
  it.each([
    'apiKey',
    'API_KEY',
    'GITHUB_TOKEN',
    'authorization',
    'client_secret',
    'password',
    'PRIVATE_KEY',
    'refreshToken',
    'connectionString',
    'SUBSCRIPTION_KEY',
  ])('flags %s', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each([
    'model',
    'command',
    'args',
    'maxTokens',
    'max_tokens',
    'tokenizer',
    'input_tokens',
    'token_limit',
    'token_url',
  ])('does not flag %s', (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe('detectSecretValue', () => {
  it.each([
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub personal access token'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop', 'GitHub fine-grained token'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'OpenAI API key'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'Anthropic API key'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    ['xoxb-1234567890-abcdefghij', 'Slack token'],
  ])('detects %s', (value, expected) => {
    expect(detectSecretValue(value)).toBe(expected);
  });

  it('detects a JSON Web Token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(detectSecretValue(jwt)).toBe('JSON Web Token');
  });

  it('detects a credentialed URL', () => {
    expect(detectSecretValue('postgres://user:hunter2@localhost:5432/db')).toBe('Credentialed URL');
  });

  it('ignores ordinary configuration values', () => {
    for (const value of ['npx', 'claude-sonnet-4', '/usr/local/bin/node', 'true', 'stdio']) {
      expect(detectSecretValue(value)).toBeUndefined();
    }
  });

  it('ignores short strings that could collide with patterns', () => {
    expect(detectSecretValue('sk-1')).toBeUndefined();
  });
});

describe('maskValue', () => {
  it('fully masks short values', () => {
    expect(maskValue('abc')).not.toContain('abc');
  });

  it('keeps a short prefix on long values so they stay distinguishable', () => {
    const masked = maskValue('ghp_abcdefghijklmnop');
    expect(masked.startsWith('ghp_')).toBe(true);
    expect(masked).not.toContain('abcdefghijklmnop');
  });
});

describe('redactValue', () => {
  it('masks credentials in an MCP env block', () => {
    const config = {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
      },
    };

    const { value, redactions } = redactValue(config);
    const redacted = value as typeof config;

    expect(redacted.mcpServers.github.command).toBe('npx');
    expect(redacted.mcpServers.github.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(redacted.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).not.toContain(
      'abcdefghijklmnop',
    );
    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.path).toBe('mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN');
  });

  it('masks every string inside env, headers, and environment blocks', () => {
    const config = { server: { env: { HARMLESS: 'value' }, headers: { 'X-Custom': 'abc' } } };
    const { redactions } = redactValue(config);
    expect(redactions.map((r) => r.path).sort()).toEqual([
      'server.env.HARMLESS',
      'server.headers.X-Custom',
    ]);
  });

  it('masks by value shape even when the key looks innocuous', () => {
    const { value, redactions } = redactValue({ note: 'AKIAIOSFODNN7EXAMPLE' });
    expect((value as { note: string }).note).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(redactions[0]?.reason).toBe('value-shape');
    expect(redactions[0]?.detector).toBe('AWS access key id');
  });

  it('records the original length without exposing the value', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { redactions } = redactValue({ token: secret });
    expect(redactions[0]?.length).toBe(secret.length);
  });

  it('leaves non-secret configuration untouched', () => {
    const config = { model: 'gpt-5', temperature: 0.2, tools: ['read', 'write'], nested: null };
    const { value, redactions } = redactValue(config);
    expect(value).toEqual(config);
    expect(redactions).toEqual([]);
  });

  it('traverses arrays and records indexed paths', () => {
    const { redactions } = redactValue({ servers: [{ apiKey: 'super-secret-value-here' }] });
    expect(redactions[0]?.path).toBe('servers[0].apiKey');
  });

  it('does not mutate the input document', () => {
    const config = { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
    redactValue(config);
    expect(config.token).toBe('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    expect(() => redactValue(node)).not.toThrow();
  });
});

describe('resolveRedactionPath', () => {
  const source = {
    mcpServers: { github: { env: { TOKEN: 'ghp_secret_value_here_1234567890' } } },
    list: [{ apiKey: 'another-secret-value' }],
  };

  it('resolves a nested object path', () => {
    expect(resolveRedactionPath(source, 'mcpServers.github.env.TOKEN')).toBe(
      'ghp_secret_value_here_1234567890',
    );
  });

  it('resolves an indexed array path', () => {
    expect(resolveRedactionPath(source, 'list[0].apiKey')).toBe('another-secret-value');
  });

  it('returns undefined for a path that does not exist', () => {
    expect(resolveRedactionPath(source, 'mcpServers.missing.env.TOKEN')).toBeUndefined();
    expect(resolveRedactionPath(source, 'list[9].apiKey')).toBeUndefined();
  });

  it('returns undefined when the path resolves to a non-string', () => {
    expect(resolveRedactionPath(source, 'mcpServers')).toBeUndefined();
  });

  it('cannot be used to reach prototype internals', () => {
    expect(resolveRedactionPath(source, 'constructor.name')).toBeUndefined();
    expect(resolveRedactionPath(source, '__proto__.polluted')).toBeUndefined();
  });
});

describe('redactText', () => {
  it('masks credentials embedded in prose', () => {
    const text = 'Set GITHUB_TOKEN to ghp_abcdefghijklmnopqrstuvwxyz0123456789 before running.';
    const { value, redactions } = redactText(text);
    expect(value).not.toContain('abcdefghijklmnop');
    expect(redactions).toHaveLength(1);
  });

  it('leaves ordinary Markdown untouched', () => {
    const text = '# Instructions\n\nAlways run the tests before committing changes.\n';
    const { value, redactions } = redactText(text);
    expect(value).toBe(text);
    expect(redactions).toEqual([]);
  });
});
