// GitHub adapter (ADR 0003). REST-FIRST: read tools call the GitHub REST API directly
// (stateless, at execute-time — nothing held across a DO turn). The official remote MCP is a
// deferred swap, gated on the MCP-lifetime spike; not built here.
//
// The CREATE (write) is NOT a model-callable tool — it's `executeCreateIssue`, run only by the
// post-approval executor in the gateway (ADR D4). The agent's create tool merely *proposes*
// (see connections/tools.ts → connectionTools), so the model never reaches a write directly.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { fetchWithTimeout, jsonMessageOrText } from './http';
import type { ToolCallRecorder, ToolCallStatus } from '../connections/audit';

const API = 'https://api.github.com';
const UA = 'morehands-agent'; // GitHub requires a User-Agent or returns 403.

function ghHeaders(pat: string): Record<string, string> {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': UA,
  };
}

// Bound every GitHub call well under the ~30s DO-turn budget (see FETCH_TIMEOUT_MS in generic-api.ts):
// an uncapped fetch that hangs can drag a turn past the point where a concurrent
// blockConcurrencyWhile(onStart) times out and resets the DO mid-turn.
const GH_FETCH_TIMEOUT_MS = 12_000;

// The single funnel every typed read goes through — which makes it the one audit point too.
async function ghGet(pat: string, audit: ToolCallRecorder | undefined, path: string): Promise<unknown> {
  const started = Date.now();
  let status: ToolCallStatus = 'fetch_error'; // a throw out of fetchWithTimeout leaves this standing
  try {
    const res = await fetchWithTimeout(`${API}${path}`, { headers: ghHeaders(pat) }, {
      timeoutMs: GH_FETCH_TIMEOUT_MS,
      timeoutMessage: `GitHub request timed out after ${GH_FETCH_TIMEOUT_MS}ms (${path}).`,
      failurePrefix: 'GitHub request failed',
    });
    status = res.ok ? 'success' : 'http_error';
    const text = await res.text();
    if (!res.ok) {
      // Surface a sanitized error to the model — status + GitHub's message, never the PAT.
      const msg = jsonMessageOrText(text, 200);
      throw new Error(`GitHub ${res.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    audit?.({ provider: 'github', method: 'GET', path, status, durationMs: Date.now() - started });
  }
}

// Trim GitHub's enormous objects to what's useful in chat (keeps tool results small).
function slimIssue(i: Record<string, unknown>): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: (i.user as { login?: string } | null)?.login,
    labels: ((i.labels as { name?: string }[]) ?? []).map((l) => l.name),
    comments: i.comments,
    url: i.html_url,
    updated_at: i.updated_at,
  };
}

/** Read-only GitHub tools, scoped to a repo via the connection's config (config.repo = "owner/name").
 *  Pass the decrypted PAT — these run at execute-time, so the PAT is used only when a tool fires. */
export function githubReadTools(pat: string, repo: string | undefined, audit?: ToolCallRecorder): ToolDefinition[] {
  const repoHint = repo ? ` Defaults to the connected repo (${repo}) when owner/name are omitted.` : '';
  const resolveRepo = (owner?: string, name?: string): { owner: string; name: string } => {
    if (owner && name) return { owner, name };
    if (repo && repo.includes('/')) {
      const [o, n] = repo.split('/');
      return { owner: o, name: n };
    }
    throw new Error('No repo specified and no default repo configured for this connection.');
  };

  const listIssues = defineTool({
    name: 'github_list_issues',
    description: `List open issues in a GitHub repo (most-recently-updated first).${repoHint}`,
    input: v.object({
      owner: v.optional(v.pipe(v.string(), v.description('Repo owner/org.'))),
      repo: v.optional(v.pipe(v.string(), v.description('Repo name.'))),
      state: v.optional(v.pipe(v.string(), v.description('"open" (default), "closed", or "all".'))),
    }),
    async run({ data: { owner, repo: r, state } }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const st = ['open', 'closed', 'all'].includes(String(state)) ? String(state) : 'open';
      const data = (await ghGet(pat, audit, `/repos/${o}/${n}/issues?state=${st}&sort=updated&per_page=20`)) as Record<
        string,
        unknown
      >[];
      // /issues returns PRs too; drop them (PRs have a pull_request field).
      const issues = data.filter((i) => !i.pull_request).map(slimIssue);
      return JSON.stringify(issues, null, 2);
    },
  });

  const getIssue = defineTool({
    name: 'github_get_issue',
    description: `Get one GitHub issue by number, with its body.${repoHint}`,
    input: v.object({
      number: v.pipe(v.number(), v.integer(), v.description('Issue number.')),
      owner: v.optional(v.pipe(v.string(), v.description('Repo owner/org.'))),
      repo: v.optional(v.pipe(v.string(), v.description('Repo name.'))),
    }),
    async run({ data: { number, owner, repo: r } }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const i = (await ghGet(pat, audit, `/repos/${o}/${n}/issues/${Number(number)}`)) as Record<string, unknown>;
      return JSON.stringify({ ...slimIssue(i), body: i.body }, null, 2);
    },
  });

  const searchIssues = defineTool({
    name: 'github_search_issues',
    description:
      'Search GitHub issues/PRs with the GitHub search syntax (e.g. "repo:owner/name is:issue is:open label:bug").',
    input: v.object({ q: v.pipe(v.string(), v.description('GitHub issue-search query.')) }),
    async run({ data: { q } }) {
      const data = (await ghGet(pat, audit, `/search/issues?q=${encodeURIComponent(String(q))}&per_page=20`)) as {
        total_count: number;
        items: Record<string, unknown>[];
      };
      return JSON.stringify({ total: data.total_count, items: data.items.map(slimIssue) }, null, 2);
    },
  });

  const searchCode = defineTool({
    name: 'github_search_code',
    description: 'Search code with the GitHub code-search syntax (e.g. "repo:owner/name connectMcpServer").',
    input: v.object({ q: v.pipe(v.string(), v.description('GitHub code-search query.')) }),
    async run({ data: { q } }) {
      const data = (await ghGet(pat, audit, `/search/code?q=${encodeURIComponent(String(q))}&per_page=20`)) as {
        total_count: number;
        items: { path?: string; repository?: { full_name?: string }; html_url?: string }[];
      };
      const items = data.items.map((i) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url }));
      return JSON.stringify({ total: data.total_count, items }, null, 2);
    },
  });

  const getFile = defineTool({
    name: 'github_get_file_contents',
    description: `Read a file's text from a GitHub repo at a path (optionally a ref/branch).${repoHint}`,
    input: v.object({
      path: v.pipe(v.string(), v.description('File path in the repo.')),
      owner: v.optional(v.pipe(v.string(), v.description('Repo owner/org.'))),
      repo: v.optional(v.pipe(v.string(), v.description('Repo name.'))),
      ref: v.optional(v.pipe(v.string(), v.description('Branch, tag, or commit SHA.'))),
    }),
    async run({ data: { path, owner, repo: r, ref } }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const q = ref ? `?ref=${encodeURIComponent(String(ref))}` : '';
      const data = (await ghGet(pat, audit, `/repos/${o}/${n}/contents/${String(path)}${q}`)) as {
        content?: string;
        encoding?: string;
        size?: number;
      };
      if (data.encoding === 'base64' && data.content) {
        const decoded = atob(data.content.replace(/\n/g, ''));
        return decoded.length > 8000 ? decoded.slice(0, 8000) + '\n…(truncated)' : decoded;
      }
      return JSON.stringify(data);
    },
  });

  return [listIssues, getIssue, searchIssues, searchCode, getFile];
}

export const GITHUB_READ_TOOL_NAMES = [
  'github_list_issues',
  'github_get_issue',
  'github_search_issues',
  'github_search_code',
  'github_get_file_contents',
] as const;

// The generic "bet on intelligence" tool (Test A) now lives in providers/generic-api.ts as a provider profile —
// github is one entry in PROVIDER_API_PROFILES. The typed read tools above remain the reversible
// fallback (apiMode: 'typed').

/** The post-approval write executor (ADR D4). Stateless — called by the gateway after the
 *  operator approves, reading args from the stored pending_actions row. Never model-callable. */
export async function executeCreateIssue(
  pat: string,
  repo: string,
  args: { title: string; body?: string },
): Promise<{ number: number; url: string }> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo "${repo}" (want owner/name).`);
  const res = await fetch(`${API}/repos/${owner}/${name}/issues`, {
    method: 'POST',
    headers: { ...ghHeaders(pat), 'content-type': 'application/json' },
    body: JSON.stringify({ title: args.title, body: args.body ?? '' }),
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = jsonMessageOrText(text, 200);
    throw new Error(`GitHub create issue ${res.status}: ${msg}`);
  }
  const created = JSON.parse(text) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}
