// Explicit local operator configuration. Importing this module performs no I/O
// against services and does not read credentials or create directories.
import {realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Set ${name} explicitly; empty, padded or control-character values are not accepted`);
  }
  return value;
}

export function requiredPath(name, env = process.env) {
  const value = requiredEnv(name, env);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute local path`);
  return resolve(value);
}

function canonicalPath(path) {
  const tail = [];
  let current = path;
  for (;;) {
    try { return resolve(realpathSync(current), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Operator path cannot be resolved');
      const parent = dirname(current);
      if (parent === current) throw new Error('Operator path cannot be resolved');
      tail.unshift(relative(parent, current)); current = parent;
    }
  }
}

function within(path, directory) {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function runtimeDir(env = process.env) {
  const configured = requiredPath('AGENT_LINK_RUNTIME_DIR', env);
  const path = canonicalPath(configured), repo = canonicalPath(repositoryRoot);
  if (path === dirname(path) || path === canonicalPath(homedir()) || within(path, repo) || within(repo, path)) {
    throw new Error('AGENT_LINK_RUNTIME_DIR must be a dedicated directory outside the source checkout');
  }
  try {
    if (!statSync(path).isDirectory()) throw new Error('AGENT_LINK_RUNTIME_DIR is not a directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return configured;
}

export function serviceOrigin(env = process.env) {
  const value = requiredEnv('AGENT_LINK_ORIGIN', env);
  if (!/^https:\/\/[^/?#\\\s@]+\/?$/i.test(value)) throw new Error('AGENT_LINK_ORIGIN must be a bare HTTPS origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('AGENT_LINK_ORIGIN is invalid'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('AGENT_LINK_ORIGIN must not contain credentials, a path, query or fragment');
  }
  return url.origin;
}

export const certificateFile = (env = process.env) => requiredPath('AGENT_LINK_CA_FILE', env);
export const browserExecutable = (env = process.env) => requiredPath('AGENT_LINK_CHROME', env);
