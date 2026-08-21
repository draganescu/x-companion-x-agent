import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveConfig,
  assertTransportAllowed,
  isInsecureAllowedHost,
  normaliseSiteUrl,
  configIdentity,
  describeConfig,
  CONFIG_FILENAME,
} from '../mcp/src/config.js';
import { XError, redact, registerSecret, clearSecrets, toEnvelope } from '../mcp/src/errors.js';

const PW = 'aaaa bbbb cccc dddd eeee ffff';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-cfg-'));
  clearSecrets();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  clearSecrets();
});

function writeConfigFile(data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(data), 'utf8');
}

describe('config precedence', () => {
  it('uses env when nothing else is present', () => {
    const cfg = resolveConfig(
      {},
      { cwd: dir, env: { X_WP_URL: 'https://env.example.com', X_WP_USER: 'envuser', X_WP_APP_PASSWORD: PW } },
    );
    expect(cfg.site_url).toBe('https://env.example.com');
    expect(cfg.user).toBe('envuser');
    expect(cfg.sources).toEqual({ url: 'env', user: 'env', app_password: 'env' });
  });

  it('.x-agent.json beats env', () => {
    writeConfigFile({ url: 'https://file.example.com', user: 'fileuser', app_password: PW });
    const cfg = resolveConfig(
      {},
      { cwd: dir, env: { X_WP_URL: 'https://env.example.com', X_WP_USER: 'envuser', X_WP_APP_PASSWORD: 'zzzz zzzz zzzz zzzz zzzz zzzz' } },
    );
    expect(cfg.site_url).toBe('https://file.example.com');
    expect(cfg.user).toBe('fileuser');
    expect(cfg.app_password).toBe(PW);
    expect(cfg.sources).toEqual({ url: 'file', user: 'file', app_password: 'file' });
    expect(cfg.config_file).toBe(path.join(dir, CONFIG_FILENAME));
  });

  it('tool arguments beat both', () => {
    writeConfigFile({ url: 'https://file.example.com', user: 'fileuser', app_password: 'ffff ffff ffff ffff ffff ffff' });
    const cfg = resolveConfig(
      { url: 'https://arg.example.com', user: 'arguser', app_password: PW },
      { cwd: dir, env: { X_WP_URL: 'https://env.example.com', X_WP_USER: 'envuser', X_WP_APP_PASSWORD: 'eeee eeee eeee eeee eeee eeee' } },
    );
    expect(cfg.site_url).toBe('https://arg.example.com');
    expect(cfg.user).toBe('arguser');
    expect(cfg.app_password).toBe(PW);
    expect(cfg.sources).toEqual({ url: 'arguments', user: 'arguments', app_password: 'arguments' });
  });

  it('merges per field across the three layers', () => {
    writeConfigFile({ user: 'fileuser' });
    const cfg = resolveConfig({ url: 'https://arg.example.com' }, { cwd: dir, env: { X_WP_APP_PASSWORD: PW } });
    expect(cfg.sources).toEqual({ url: 'arguments', user: 'file', app_password: 'env' });
  });

  it('accepts site_url as an alias in the config file', () => {
    writeConfigFile({ site_url: 'https://alias.example.com', user: 'u', app_password: PW });
    expect(resolveConfig({}, { cwd: dir, env: {} }).site_url).toBe('https://alias.example.com');
  });

  it('reports every missing field as invalid_input', () => {
    try {
      resolveConfig({}, { cwd: dir, env: {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(XError);
      const env = toEnvelope(e);
      expect(env.code).toBe('invalid_input');
      expect(env.missing).toEqual(['url (X_WP_URL)', 'user (X_WP_USER)', 'app_password (X_WP_APP_PASSWORD)']);
    }
  });

  it('rejects a malformed .x-agent.json with a structured error', () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), '{not json', 'utf8');
    expect(() => resolveConfig({}, { cwd: dir, env: {} })).toThrow(XError);
  });

  it('normalises trailing slashes and strips userinfo', () => {
    const cfg = resolveConfig({ url: 'https://u:p@site.example.com/', user: 'a', app_password: PW }, { cwd: dir, env: {} });
    expect(cfg.site_url).toBe('https://site.example.com');
  });

  it('configIdentity and describeConfig never leak the password', () => {
    const cfg = resolveConfig({ url: 'https://x.example.com', user: 'a', app_password: PW }, { cwd: dir, env: {} });
    expect(configIdentity(cfg)).toBe('https://x.example.com|a');
    expect(JSON.stringify(describeConfig(cfg))).not.toContain('aaaa');
  });
});

describe('https policy', () => {
  it('accepts https everywhere', () => {
    expect(assertTransportAllowed('https://example.com').protocol).toBe('https:');
  });

  for (const host of ['localhost', '127.0.0.1', '[::1]', 'wp.localhost', 'playground.wordpress.net', 'my.playground.dev']) {
    it(`allows plain http for ${host}`, () => {
      expect(() => assertTransportAllowed(`http://${host}:8888`)).not.toThrow();
      expect(isInsecureAllowedHost(host)).toBe(true);
    });
  }

  for (const host of ['example.com', 'wp.example.org', 'notlocalhost.com', 'playgrounds.example.com']) {
    it(`refuses plain http for ${host} with https_required`, () => {
      try {
        assertTransportAllowed(`http://${host}`);
        throw new Error('should have thrown');
      } catch (e) {
        expect(toEnvelope(e).code).toBe('https_required');
      }
    });
  }

  it('refuses http for a non-local host through resolveConfig too', () => {
    try {
      resolveConfig({ url: 'http://public.example.com', user: 'a', app_password: PW }, { cwd: dir, env: {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect(toEnvelope(e).code).toBe('https_required');
    }
  });

  it('refuses a non-http scheme as invalid_input', () => {
    expect(toEnvelope(catchIt(() => assertTransportAllowed('ftp://example.com'))).code).toBe('invalid_input');
  });

  it('refuses a non-URL as invalid_input', () => {
    expect(toEnvelope(catchIt(() => assertTransportAllowed('example.com'))).code).toBe('invalid_input');
  });

  it('normaliseSiteUrl drops query, hash and trailing slash', () => {
    expect(normaliseSiteUrl(new URL('https://example.com/wp/?x=1#y'))).toBe('https://example.com/wp');
  });
});

describe('redaction', () => {
  it('scrubs a registered secret anywhere in a string', () => {
    registerSecret(PW);
    expect(redact(`password is ${PW} ok`)).toBe('password is *** ok');
    expect(redact(`compact ${PW.replace(/ /g, '')}`)).toBe('compact ***');
  });

  it('scrubs Basic auth headers and URL userinfo without any registration', () => {
    expect(redact('Authorization: Basic YWdlbnQ6c2VjcmV0')).toBe('Authorization: Basic ***');
    expect(redact('https://agent:hunter2@example.com/wp-json')).toBe('https://agent:***@example.com/wp-json');
  });

  it('scrubs the WordPress application-password shape even unregistered', () => {
    expect(redact('use 1234 abcd 5678 efgh 9012 ijkl now')).toBe('use *** now');
  });

  it('resolveConfig registers the password so later logging is safe', () => {
    resolveConfig({ url: 'https://x.example.com', user: 'a', app_password: PW }, { cwd: dir, env: {} });
    expect(redact(`leak ${PW}`)).toBe('leak ***');
  });

  it('toEnvelope redacts message and extra fields', () => {
    registerSecret(PW);
    const env = toEnvelope(new XError('companion_error', `failed with ${PW}`, 'hint', { app_password: PW, nested: { note: PW } }));
    expect(JSON.stringify(env)).not.toContain('aaaa');
    expect(env.app_password).toBe('***');
  });

  it('wraps an unknown throw as {code:"internal"} instead of leaking it', () => {
    const env = toEnvelope(new TypeError('boom'));
    expect(env.code).toBe('internal');
    expect(env.hint.length).toBeGreaterThan(0);
  });
});

function catchIt(fn: () => unknown): unknown {
  try {
    fn();
    return new Error('did not throw');
  } catch (e) {
    return e;
  }
}
