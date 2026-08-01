import { describe, expect, it } from 'vitest';

import { redactDocumentText, REDACTED_PLACEHOLDER } from '../src/redact.js';

describe('redactDocumentText', () => {
  it('masks a value whose key name looks secret', () => {
    const { value, redactions } = redactDocumentText('password: hunter2\n');
    expect(value).not.toContain('hunter2');
    expect(value).toContain(REDACTED_PLACEHOLDER);
    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.reason).toBe('key-name');
  });

  it('masks a value whose shape looks secret regardless of key', () => {
    const { value, redactions } = redactDocumentText(
      'note: ghp_1234567890abcdefghijklmnopqrstuvwxyz\n',
    );
    expect(value).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(redactions[0]?.reason).toBe('value-shape');
  });

  it('preserves comments, key order, and formatting', () => {
    const source = [
      '{',
      '  // VS Code writes JSONC with comments',
      '  "theme": "dark",',
      '  "apiKey": "abcd1234efgh5678",',
      '  "banner": "always"',
      '}',
    ].join('\n');

    const { value } = redactDocumentText(source);
    const lines = value.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('  // VS Code writes JSONC with comments');
    expect(lines[2]).toBe('  "theme": "dark",');
    expect(lines[3]).toContain('"apiKey"');
    expect(lines[3]).not.toContain('abcd1234efgh5678');
    expect(lines[5]).toBe('}');
  });

  it('handles JSON, YAML, and TOML assignment styles', () => {
    const { value } = redactDocumentText(
      [
        '"token": "aaaaaaaaaaaaaaaa",',
        'token: bbbbbbbbbbbbbbbb',
        'token = "cccccccccccccccc"',
      ].join('\n'),
    );
    expect(value).not.toMatch(/aaaaaaaa|bbbbbbbb|cccccccc/);
    expect(value.split('\n')).toHaveLength(3);
  });

  it('leaves templated placeholders alone', () => {
    const source = [
      '"apiKey": "${input:api-key}"',
      '"token": "${user_config.api_key}"',
      '"secret": "$MY_SECRET"',
      '"password": "{{ vault.password }}"',
      '"key": "%API_KEY%"',
      '"auth": "<your-token-here>"',
    ].join('\n');

    const { value, redactions } = redactDocumentText(source);
    expect(value).toBe(source);
    expect(redactions).toEqual([]);
  });

  it('leaves benign values with token-ish key names alone', () => {
    const source = [
      'maxTokens: 4096',
      'tokenizer: cl100k_base',
      'token_url: https://example.com',
    ].join('\n');
    expect(redactDocumentText(source).value).toBe(source);
  });

  it('does not mask a literal that cannot be a credential', () => {
    // VS Code writes `"password": true` to mark a prompt input as masked.
    const source = [
      '"password": true,',
      '"secret": false',
      '"apiKey": null',
      '"token": 4096',
      '"key": -1.5',
    ].join('\n');
    const { value, redactions } = redactDocumentText(source);
    expect(value).toBe(source);
    expect(redactions).toEqual([]);
  });

  it('masks bare credentials on non-assignment lines', () => {
    const source = 'Use this key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 when calling.';
    const { value, redactions } = redactDocumentText(source);
    expect(value).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(value).toContain('Use this key:');
    expect(redactions).toHaveLength(1);
  });

  it('masks a PEM block', () => {
    const source = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx7Fh2K9pQm3vLd8sT1nW4uY6bC0eR5gH2jK8mN3pQ7rS9tU1',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { value } = redactDocumentText(source);
    expect(value).not.toContain('MIIEowIBAAKCAQEAx7Fh2K9pQm3vLd8sT1nW4uY6bC0eR5gH2jK8mN3pQ7rS9tU1');
  });

  it('gives every redaction a unique, stable id and a locating path', () => {
    const source = ['"apiKey": "aaaaaaaaaaaaaaaa"', '"secret": "bbbbbbbbbbbbbbbb"'].join('\n');
    const first = redactDocumentText(source);
    const second = redactDocumentText(source);

    expect(first.redactions.map((entry) => entry.id)).toEqual(['r0', 'r1']);
    expect(new Set(first.redactions.map((entry) => entry.id)).size).toBe(2);
    expect(first.redactions.map((entry) => entry.path)).toEqual(
      second.redactions.map((entry) => entry.path),
    );
    expect(first.redactions[0]?.path).toContain('apiKey');
    expect(first.redactions[0]?.length).toBe('aaaaaaaaaaaaaaaa'.length);
  });

  it('names the key for a secret inside an inline object', () => {
    const source = '  "env": { "SCRATCH_TOKEN": "sk-live-shouldbemasked123" }';
    const { value, redactions } = redactDocumentText(source);

    expect(value).not.toContain('shouldbemasked123');
    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.path).toBe('SCRATCH_TOKEN@1');
  });

  it('distinguishes two secrets sharing one line', () => {
    const source =
      '{ "clientSecret": "sk-live-firstsecret0001", "apiKey": "sk-live-secondsecret0002" }';
    const { redactions } = redactDocumentText(source);

    expect(redactions).toHaveLength(2);
    expect(redactions.map((entry) => entry.path)).toEqual(['clientSecret@1', 'apiKey@1']);
  });

  it('masks every string inside an env block', () => {
    const source = [
      '  "env": {',
      '    "GITHUB_PERSONAL_ACCESS_TOKEN": "abcdefghijklmnop",',
      '    "SOME_SETTING": "qrstuvwxyz012345"',
      '  }',
    ].join('\n');
    const { value } = redactDocumentText(source);
    expect(value).not.toContain('abcdefghijklmnop');
  });

  it('preserves non-secret structure exactly', () => {
    const source = ['{', '  "model": "claude-sonnet-4",', '  "maxTokens": 4096', '}'].join('\n');
    const { value, redactions } = redactDocumentText(source);
    expect(value).toBe(source);
    expect(redactions).toEqual([]);
  });

  it('handles empty input and preserves trailing newlines', () => {
    expect(redactDocumentText('').value).toBe('');
    expect(redactDocumentText('a: 1\n').value).toBe('a: 1\n');
  });

  it('preserves CRLF line endings', () => {
    const source = '{\r\n  "model": "opus"\r\n}';
    expect(redactDocumentText(source).value).toBe(source);
  });
});
