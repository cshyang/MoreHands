// Global people record — thin, cross-channel facts about humans, shared by every channel
// agent. Rows live in the existing `memories` table under project_id='__global__',
// scope='user', subject='slack:<team>:<user>' (the shape migration 0001 reserved).
//
// CONSENT RULE (enforced by prompt + auditability, not code): only SELF-STATED, profile-thin
// facts get promoted here — role, timezone, preferences, what someone owns. Third-party
// claims are gossip and stay in channel memory. created_by records the source channel so a
// bad entry is attributable and cleanable. Read path is tool-time (who_is), never injected.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';

export const GLOBAL_PROJECT_ID = '__global__';
/** Thin means thin: a person is a handful of facts, not a dossier. */
export const PERSON_FACT_CAP = 12;

export interface PersonFact {
  id: number;
  subject: string;
  fact: string;
}

export async function listPersonFacts(db: D1Like, query?: string): Promise<PersonFact[]> {
  const base = `SELECT id, subject, fact FROM memories WHERE project_id=? AND scope='user'`;
  const stmt = query
    ? db.prepare(`${base} AND (subject LIKE ? OR fact LIKE ?) ORDER BY subject, id`).bind(GLOBAL_PROJECT_ID, `%${query}%`, `%${query}%`)
    : db.prepare(`${base} ORDER BY subject, id`).bind(GLOBAL_PROJECT_ID);
  const { results } = await stmt.all<{ id: number; subject: string; fact: string }>();
  return (results ?? []).map((r) => ({ id: r.id, subject: r.subject, fact: r.fact }));
}

export async function savePersonFact(
  db: D1Like,
  input: { subject: string; fact: string; sourceProjectId: string },
): Promise<{ id?: number; saved: boolean; reason?: string }> {
  const subject = String(input.subject ?? '').trim();
  const fact = String(input.fact ?? '').trim();
  if (!subject) throw new Error('person fact requires a subject (the person\'s sender id, e.g. "slack:T123:U456")');
  if (!fact) throw new Error('person fact requires a non-empty fact');

  const existing = await listPersonFacts(db);
  const forSubject = existing.filter((f) => f.subject === subject);
  if (forSubject.some((f) => f.fact === fact)) return { saved: false, reason: 'duplicate — this exact fact is already recorded' };
  if (forSubject.length >= PERSON_FACT_CAP) {
    return { saved: false, reason: `cap reached (${PERSON_FACT_CAP} facts) — forget_person_fact something stale first` };
  }

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO memories(project_id, scope, subject, fact, created_by, updated_by, created_at, updated_at)
       VALUES(?, 'user', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(GLOBAL_PROJECT_ID, subject, fact, input.sourceProjectId, input.sourceProjectId, now, now)
    .run();
  return { saved: true };
}

export async function forgetPersonFact(db: D1Like, id: number): Promise<{ found: boolean }> {
  const res = (await db
    .prepare(`DELETE FROM memories WHERE project_id=? AND scope='user' AND id=?`)
    .bind(GLOBAL_PROJECT_ID, id)
    .run()) as { meta?: { changes?: number } };
  return { found: (res?.meta?.changes ?? 0) > 0 };
}

export function renderPersonFacts(facts: PersonFact[]): string {
  if (!facts.length) return 'No global people facts recorded.';
  const bySubject = new Map<string, PersonFact[]>();
  for (const f of facts) {
    const list = bySubject.get(f.subject) ?? [];
    list.push(f);
    bySubject.set(f.subject, list);
  }
  return [...bySubject.entries()]
    .map(([subject, list]) => `${subject}\n${list.map((f) => `  [${f.id}] ${f.fact}`).join('\n')}`)
    .join('\n');
}

export function peopleTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  const store = (): D1Like => {
    if (!db) throw new Error('People record is unavailable (no DB binding).');
    return db;
  };

  const whoIs = defineTool({
    name: 'who_is',
    description:
      'Look up the company-wide people record (shared across ALL channels): role, timezone, preferences, ' +
      'ownership. Pass a name or a sender id to filter, or omit to list everyone. Use this before answering ' +
      'questions about a person and before save_person_fact (to avoid near-duplicates).',
    input: v.object({
      query: v.optional(v.pipe(v.string(), v.description('Name fragment or sender id, e.g. "Sarah" or "slack:T123:U456". Omit for all.'))),
    }),
    async run({ data: { query } }) {
      return renderPersonFacts(await listPersonFacts(store(), query ? String(query) : undefined));
    },
  });

  const savePersonFactTool = defineTool({
    name: 'save_person_fact',
    description:
      'Record a SELF-STATED, profile-thin fact about a person into the company-wide people record — visible ' +
      'to every channel agent. Allowed: role, timezone/location, working preferences, what they own ("Sarah ' +
      'owns the deploy pipeline (slack:T1:U2, self-stated in #eng)"). NOT allowed: third-party claims, opinions ' +
      'about people, anything sensitive or from a clearly private context — those stay in channel memory. ' +
      'Subject is the person\'s sender id from the dispatch input; start the fact with their name.',
    input: v.object({
      subject: v.pipe(v.string(), v.description('The person\'s qualified sender id, e.g. "slack:T0B6VB:U0B6VB" — copy it from the dispatch input.')),
      fact: v.pipe(v.string(), v.description('One compact declarative fact, starting with the person\'s name.')),
    }),
    async run({ data: { subject, fact } }) {
      const res = await savePersonFact(store(), { subject: String(subject), fact: String(fact), sourceProjectId: projectId });
      return res.saved ? 'saved to the global people record.' : `not saved: ${res.reason}`;
    },
  });

  const forgetPersonFactTool = defineTool({
    name: 'forget_person_fact',
    description:
      'Delete a fact from the company-wide people record by id (from who_is). Use when a person corrects or ' +
      'asks to remove something about themselves — honor that immediately.',
    input: v.object({ id: v.pipe(v.number(), v.description('Fact id from who_is output.')) }),
    async run({ data: { id } }) {
      const res = await forgetPersonFact(store(), Number(id));
      return res.found ? `forgot fact ${id}.` : `no fact with id ${id} in the people record.`;
    },
  });

  return [whoIs, savePersonFactTool, forgetPersonFactTool];
}
