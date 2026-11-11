/**
 * What a Funnel client may do once the bearer matches.
 * Admin routes are never in scope. A write whose source is shared is refused
 * even when a record's write list was built by a caller that bypassed the
 * token-file parser.
 */
import type { ClientRecord } from './tokens.ts';

export type RouteClass = 'health' | 'mcp' | 'admin' | 'other';

export type PolicyDecision =
  | { ok: true }
  | { ok: false; status: 403; error: 'forbidden'; code: 'wrong_scope' | 'admin_forbidden' | 'shared_write_forbidden' };

const READ_TOOLS = new Set([
  'recall', 'search', 'query', 'get_page', 'list_pages', 'get_backlinks', 'get_timeline',
  'entity', 'context_pack', 'delta', 'find_pages', 'get_stats', 'whois', 'get_versions',
  'find_trajectory', 'resources/read',
]);

const METHODS_WITHOUT_SOURCE = new Set([
  'initialize', 'ping', 'tools/list', 'resources/list', 'prompts/list', 'completion/complete',
  'logging/setLevel', 'notifications/initialized', 'notifications/cancelled', 'notifications/progress',
]);

export function routeClass(pathname: string): RouteClass {
  const path = pathname.split('?')[0] || '/';
  if (path === '/health' || path === '/health/') return 'health';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (
    path === '/admin' || path.startsWith('/admin/')
    || path === '/metrics' || path.startsWith('/metrics/')
    || path === '/token' || path === '/register' || path === '/revoke' || path === '/authorize'
    || path.startsWith('/.well-known')
  ) return 'admin';
  return 'other';
}

function collectSources(value: unknown, found: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, found);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'source' || key === 'source_id' || key === 'sourceId') && typeof child === 'string') {
      found.push(child);
      continue;
    }
    if ((key === 'source' || key === 'sources' || key === 'source_id') && Array.isArray(child)) {
      for (const item of child) if (typeof item === 'string') found.push(item);
      continue;
    }
    collectSources(child, found);
  }
}

function decideSources(tool: string, sources: string[], record: ClientRecord): PolicyDecision {
  const reading = READ_TOOLS.has(tool);
  if (!reading && sources.includes('shared')) {
    return { ok: false, status: 403, error: 'forbidden', code: 'shared_write_forbidden' };
  }
  const allowed = reading ? record.read : record.write;
  for (const source of sources) {
    if (!allowed.includes(source)) return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  }
  return { ok: true };
}

function decideCall(message: Record<string, unknown>, record: ClientRecord): PolicyDecision {
  const method = typeof message.method === 'string' ? message.method : '';
  if (method.startsWith('notifications/') || METHODS_WITHOUT_SOURCE.has(method)) return { ok: true };
  if (method === 'resources/read') {
    const sources: string[] = [];
    collectSources(message.params, sources);
    return decideSources('resources/read', sources, record);
  }
  if (method !== 'tools/call') return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  const params = message.params;
  if (!params || typeof params !== 'object') return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.length === 0) return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  if (!READ_TOOLS.has(name) && !isKnownWrite(name)) return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  const sources: string[] = [];
  collectSources(params, sources);
  return decideSources(name, sources, record);
}

function isKnownWrite(name: string): boolean {
  return [
    'remember', 'put_page', 'delete_page', 'forget', 'add_link', 'remove_link', 'capture',
    'file_upload', 'import_file', 'synthesize', 'update_page', 'restore_page', 'append_page',
    'edit_page', 'add_page',
  ].includes(name);
}

export function evaluateMcpBody(body: string, record: ClientRecord): PolicyDecision | { ok: false; status: 400; error: 'bad_json' } {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, status: 400, error: 'bad_json' }; }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
  for (const message of messages) {
    if (!message || typeof message !== 'object') return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
    const decision = decideCall(message as Record<string, unknown>, record);
    if (!decision.ok) return decision;
  }
  return { ok: true };
}

export function queryTargetsSharedWrite(method: string, search: string, headerSource: string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('source') === 'shared' || params.get('source_id') === 'shared') return true;
  return headerSource === 'shared';
}

export function authorizeRoute(route: RouteClass, record: ClientRecord): PolicyDecision {
  if (route === 'admin') return { ok: false, status: 403, error: 'forbidden', code: 'admin_forbidden' };
  if (route === 'health' && record.routes.includes('health')) return { ok: true };
  if (route === 'mcp' && record.routes.includes('mcp')) return { ok: true };
  return { ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' };
}
