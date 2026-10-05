import { bindingByProject, parseAgentInstanceId, type Binding } from '../project/bindings';
import { loadPersona, type Persona } from '../project/persona';
import { assignSoul, SOUL_NAME_PREFIX } from '../project/souls';
import { loadSkillCatalog, loadActiveSkillBody, skillBody, type D1Like } from '../skills/repository';
import { loadProjectMemory, renderMemory } from '../knowledge/memory';
import { loadConnectionSnapshot, type ConnectionSnapshot } from '../connections/runtime';

/** Gateway-loaded, serializable metadata for the very first render of each delivery.
 *  Never put env bindings, resolved credentials, or tool functions in this snapshot. */
export interface ProjectContext {
  projectId: string;
  slug: string;
  binding: Binding | null;
  persona: Persona | null;
  catalog: { name: string; description: string }[];
  personality: string | null;
  memoryBlock: string | null;
  connections: ConnectionSnapshot;
}

export function parseProjectDispatchInput(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function isEngagedProjectInput(attributes: Record<string, string> | undefined, input: Record<string, unknown> | null): boolean {
  return attributes?.engaged !== undefined
    ? attributes.engaged === 'true'
    : typeof input?.message === 'string' && input.kind !== 'heartbeat';
}

export async function loadProjectContext(env: Record<string, unknown>, id: string,
  options?: { persona: Persona | null; strictDb?: boolean }): Promise<ProjectContext> {
  const { projectId, slug } = parseAgentInstanceId(id);
  const db = env.DB as D1Like | undefined;
  const binding = await bindingByProject(projectId, db, options);
  if (!binding) return {
    projectId, slug, binding: null, persona: null, catalog: [], personality: null,
    memoryBlock: null, connections: { specs: [], enabledIntegrations: [] },
  };

  let persona = options ? options.persona : db ? await loadPersona(db, projectId).catch(() => null) : null;
  if (!options && db && !persona) {
    const assigned = await assignSoul(db, projectId).catch(() => null);
    if (assigned) persona = await loadPersona(db, projectId).catch(() => null);
  }
  // Durable preparation must retry unavailable reads before freezing a partial snapshot.
  const fallback = <T>(value: T) => (error: unknown): T => {
    if (options?.strictDb) throw error;
    return value;
  };
  const skills = db ? await loadSkillCatalog(db, projectId).catch(fallback([])) : [];
  const personality = db && skills.some((skill) => skill.name === 'personality')
    ? await loadActiveSkillBody(db, projectId, 'personality').catch(fallback(null))
    : null;
  const memory = db ? await loadProjectMemory(db, projectId).catch(fallback([])) : [];
  const connections = await loadConnectionSnapshot({ db, binding, env, strictDb: options?.strictDb });
  return {
    projectId,
    slug,
    binding,
    persona,
    catalog: skills.filter((skill) => skill.name !== 'personality' && !skill.name.startsWith(SOUL_NAME_PREFIX))
      .map(({ name, description }) => ({ name, description })),
    personality: personality ? skillBody(personality) : null,
    memoryBlock: renderMemory(memory),
    connections,
  };
}

/** Current delivery wins over creation data, including refreshed model/personality/connection state.
 *  A missing or mismatched snapshot is inert; never reuse another project's creation data. */
export function projectContextForDelivery(id: string, snapshot: string | undefined, initial: ProjectContext | undefined): ProjectContext | null {
  const { projectId, slug } = parseAgentInstanceId(id);
  let current: ProjectContext | undefined;
  if (snapshot !== undefined) {
    try { current = JSON.parse(snapshot) as ProjectContext; } catch { return null; }
  } else current = initial;
  if (!current || current.projectId !== projectId || current.slug !== slug) return null;
  if (current.binding && (current.binding.projectId !== projectId || current.binding.status !== 'active')) return null;
  if (!Array.isArray(current.catalog) || !Array.isArray(current.connections?.specs) || !Array.isArray(current.connections.enabledIntegrations)) return null;
  return current;
}
