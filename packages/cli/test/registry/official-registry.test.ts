import { describe, it, expect } from 'vitest';
import {
  validateServerName,
  parseGitHubRepo,
  deriveServerName,
  parseEnvExample,
  buildServerJson,
  OFFICIAL_SCHEMA_URL,
} from '../../src/registry/official-registry.js';

describe('validateServerName', () => {
  it('accepts a reverse-DNS namespaced name', () => {
    expect(validateServerName('io.github.you/my-server')).toBeNull();
    expect(validateServerName('com.example/weather')).toBeNull();
  });

  it('rejects a name without a namespace separator', () => {
    expect(validateServerName('my-server')).toMatch(/namespace/);
  });

  it('rejects more than one slash', () => {
    expect(validateServerName('io.github.you/a/b')).toMatch(/exactly one/);
  });

  it('rejects a namespace without a dot', () => {
    expect(validateServerName('github/my-server')).toMatch(/reverse-DNS/);
  });

  it('rejects illegal characters in the server segment', () => {
    expect(validateServerName('io.github.you/bad name')).toMatch(/may only contain/);
  });
});

describe('parseGitHubRepo', () => {
  it('parses https URLs', () => {
    expect(parseGitHubRepo('https://github.com/Acme/My-Repo')).toEqual({
      owner: 'Acme',
      repo: 'My-Repo',
    });
  });

  it('parses https URLs with a .git suffix and trailing slash', () => {
    expect(parseGitHubRepo('https://github.com/acme/my-repo.git/')).toEqual({
      owner: 'acme',
      repo: 'my-repo',
    });
  });

  it('parses ssh URLs', () => {
    expect(parseGitHubRepo('git@github.com:acme/my-repo.git')).toEqual({
      owner: 'acme',
      repo: 'my-repo',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepo('https://gitlab.com/acme/my-repo')).toBeNull();
  });
});

describe('deriveServerName', () => {
  it('prefers an explicit name', () => {
    expect(
      deriveServerName({ explicit: 'io.github.you/x', repositoryUrl: 'https://github.com/a/b' }),
    ).toBe('io.github.you/x');
  });

  it('derives io.github.<owner>/<repo> from a repo URL (owner lowercased)', () => {
    expect(deriveServerName({ repositoryUrl: 'https://github.com/Acme/Weather' })).toBe(
      'io.github.acme/Weather',
    );
  });

  it('returns null when nothing is available', () => {
    expect(deriveServerName({})).toBeNull();
    expect(deriveServerName({ repositoryUrl: 'https://example.com/x' })).toBeNull();
  });
});

describe('parseEnvExample', () => {
  it('extracts names, descriptions, and the secret heuristic', () => {
    const env = [
      '# API base URL',
      'BASE_URL=https://api.example.com',
      '',
      '# Bearer authentication token',
      'BEARER_TOKEN=',
    ].join('\n');
    const vars = parseEnvExample(env);
    expect(vars).toEqual([
      {
        name: 'BASE_URL',
        description: 'API base URL',
        isRequired: true,
        isSecret: false,
        format: 'string',
      },
      {
        name: 'BEARER_TOKEN',
        description: 'Bearer authentication token',
        isRequired: true,
        isSecret: true,
        format: 'string',
      },
    ]);
  });

  it('ignores blank lines, bare comments, and malformed entries', () => {
    expect(parseEnvExample('\n# orphan comment\n')).toEqual([]);
    expect(parseEnvExample('=novalue\n123BAD=x')).toEqual([]);
  });

  it('handles export-prefixed vars', () => {
    expect(parseEnvExample('export API_KEY=abc')[0]).toMatchObject({
      name: 'API_KEY',
      isSecret: true,
    });
  });
});

describe('buildServerJson', () => {
  const base = {
    name: 'io.github.you/weather',
    version: '1.2.0',
    packageIdentifier: '@you/weather-mcp',
    packageVersion: '1.2.0',
  };

  it('builds a schema-conformant minimal server.json', () => {
    const json = buildServerJson(base);
    expect(json.$schema).toBe(OFFICIAL_SCHEMA_URL);
    expect(json.name).toBe('io.github.you/weather');
    expect(json.version).toBe('1.2.0');
    expect(json.packages).toEqual([
      {
        registryType: 'npm',
        identifier: '@you/weather-mcp',
        version: '1.2.0',
        transport: { type: 'stdio' },
      },
    ]);
    // optional fields absent when not provided
    expect(json.description).toBeUndefined();
    expect(json.repository).toBeUndefined();
    expect(json.remotes).toBeUndefined();
  });

  it('includes description, repository, and env vars when provided', () => {
    const json = buildServerJson({
      ...base,
      description: 'Weather data',
      repositoryUrl: 'https://github.com/you/weather-mcp',
      environmentVariables: [
        { name: 'API_KEY', isRequired: true, isSecret: true, format: 'string' },
      ],
    });
    expect(json.description).toBe('Weather data');
    expect(json.repository).toEqual({
      url: 'https://github.com/you/weather-mcp',
      source: 'github',
    });
    expect(json.packages![0].environmentVariables).toHaveLength(1);
  });

  it('omits an empty environmentVariables array', () => {
    const json = buildServerJson({ ...base, environmentVariables: [] });
    expect(json.packages![0].environmentVariables).toBeUndefined();
  });

  it('adds a streamable-http remote when a remote URL is given', () => {
    const json = buildServerJson({ ...base, remoteUrl: 'https://weather.example.com/mcp' });
    expect(json.remotes).toEqual([
      { type: 'streamable-http', url: 'https://weather.example.com/mcp' },
    ]);
  });
});
