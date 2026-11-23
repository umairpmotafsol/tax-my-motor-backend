/**
 * Where the Firebase key comes from. The one thing worth pinning is that
 * a host with no disk (Heroku) can supply it inline — and that a bad
 * value says what is wrong without quoting the private key.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCredentials, parseInlineCredentials } from './push.provider';

const KEY = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nSECRET-BODY\n-----END PRIVATE KEY-----\n',
};
const json = JSON.stringify(KEY);
const base64 = Buffer.from(json, 'utf8').toString('base64');

describe('parseInlineCredentials', () => {
  it('reads the JSON itself', () => {
    expect(parseInlineCredentials(json)).toEqual(KEY);
  });

  it('reads base64-encoded JSON, with the private key newlines intact', () => {
    expect(parseInlineCredentials(base64).private_key).toBe(KEY.private_key);
  });

  it('ignores whitespace around the value', () => {
    expect(parseInlineCredentials('\n  ' + json + '  \n')).toEqual(KEY);
  });

  it('refuses something that is not a key, without quoting it', () => {
    expect(() => parseInlineCredentials('not json at all')).toThrow(
      'FIREBASE_CREDENTIALS_JSON is neither JSON nor base64-encoded JSON.',
    );
  });

  it('names the missing fields but never the values', () => {
    const attempt = () => parseInlineCredentials(JSON.stringify({ project_id: 'demo-project' }));
    expect(attempt).toThrow('missing client_email, private_key');
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});

describe('loadCredentials', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'push-key-'));
    file = join(dir, 'key.json');
    writeFileSync(file, JSON.stringify({ ...KEY, project_id: 'from-the-file' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the inline key when there is one', () => {
    const loaded = loadCredentials(json, '/does/not/exist.json');
    expect(loaded.credentials?.project_id).toBe('demo-project');
    expect(loaded.source).toBe('FIREBASE_CREDENTIALS_JSON');
  });

  it('prefers the inline key over the file', () => {
    expect(loadCredentials(json, file).credentials?.project_id).toBe('demo-project');
  });

  it('falls back to the file', () => {
    const loaded = loadCredentials('', file);
    expect(loaded.credentials?.project_id).toBe('from-the-file');
    expect(loaded.source).toBe(file);
  });

  it('is off, not an error, when there is neither', () => {
    expect(loadCredentials('', join(dir, 'missing.json')).credentials).toBeNull();
    expect(loadCredentials('   ', '').credentials).toBeNull();
  });
});
