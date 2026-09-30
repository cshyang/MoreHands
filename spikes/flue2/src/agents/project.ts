'use agent';
// Minimal stand-in for MoreHands' project agent, to answer the Flue 2 spike questions.
//
// Q1 pattern under test: the 2.x agent function is synchronous, so D1 is read in an async
// useAgentStart seam, persisted with a usePersistentState setter, and the next render reads the
// durable value to build model/instructions/tools.
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  defineTool,
  useAgentStart,
  useDelivery,
  useInitialData,
  useInstruction,
  useModel,
  usePersistentState,
  useTool,
  type AgentProps,
} from '@flue/runtime';
import { ensureFakeModels } from '../fake-model';

ensureFakeModels();

interface Loaded {
  persona: string | null;
  model: string | null;
  memory: string[];
}

function projectIdOf(id: string): string {
  // Same shape as src/project/bindings.ts agentInstanceId(): project:<id>:agent:<slug>[/scope][@gN]
  const m = id.match(/^project:(.+?):agent:/);
  return m ? m[1] : id;
}

async function loadFromD1(projectId: string): Promise<Loaded> {
  const db = (env as any).DB as D1Database;
  const b = await db.prepare('SELECT persona, model FROM bindings WHERE project_id=?').bind(projectId).first<{ persona: string; model: string }>();
  const { results } = await db.prepare('SELECT fact FROM memories WHERE project_id=? ORDER BY id').bind(projectId).all<{ fact: string }>();
  return { persona: b?.persona ?? null, model: b?.model ?? null, memory: (results ?? []).map((r) => r.fact) };
}

export function Project({ id }: AgentProps) {
  const projectId = projectIdOf(id);
  const [loaded, setLoaded] = usePersistentState<Loaded | null>('d1ctx', null);
  const delivery = useDelivery();
  const sender = delivery.kind === 'signal' ? delivery.attributes?.sender : undefined;
  const conversationId = delivery.kind === 'signal' ? delivery.attributes?.conversationId : undefined;

  // useModel is submission-scoped: read once when the submission starts (BEFORE useAgentStart).
  // Precedence under test: fresh delivery attribute > creation-time initialData > durable state from
  // the PREVIOUS start seam > default.
  const initial = useInitialData<{ model?: string; d1?: Loaded } | undefined>();
  const ctx: Loaded | null = loaded ?? initial?.d1 ?? null; // gateway-seeded creation data covers turn 1 of a NEW instance
  const deliveredModel = delivery.kind === 'signal' ? delivery.attributes?.model : undefined;
  useModel(deliveredModel ?? initial?.model ?? ctx?.model ?? 'faux/model-a');

  useAgentStart(async ({ log, append }) => {
    const fresh = await loadFromD1(projectId);
    setLoaded(fresh); // deep-equal writes are a no-op
    // First-turn fix under test: ctx.append steers a signal into THIS response before turn one, so the
    // model sees fresh D1 data on turn 1 even though the system-prompt render ran before this seam.
    if (delivery.kind === 'signal' && delivery.attributes?.appendFresh) {
      append({ kind: 'signal', type: 'project.context', body: `persona=${fresh.persona}; memory=${fresh.memory.join(' | ')}` });
    }
    log.info('d1 loaded', { projectId, persona: fresh.persona, memory: fresh.memory.length, sender: sender ?? null });
  });

  if (sender) useInstruction(`Current sender (from useDelivery): ${sender}`);
  if (ctx?.memory.length) useInstruction(`Memory:\n${ctx.memory.map((f) => `- ${f}`).join('\n')}`);

  useTool(
    defineTool({
      name: 'who_am_i',
      description: 'Return the delivery author as seen by agent code (not echoed by the model).',
      input: v.object({}),
      run: () => ({ output: { sender: sender ?? null, conversationId: conversationId ?? null } }),
    }),
  );
  useTool(
    defineTool({
      name: 'save_memory',
      description: 'Save a fact to D1 and refresh durable state so the next render injects it.',
      input: v.object({ fact: v.string() }),
      run: async ({ data }) => {
        const db = (env as any).DB as D1Database;
        await db.prepare('INSERT INTO memories(project_id, fact) VALUES (?,?)').bind(projectId, data.fact).run();
        setLoaded((prev) => ({ persona: prev?.persona ?? null, model: prev?.model ?? null, memory: [...(prev?.memory ?? []), data.fact] }));
        return { output: { saved: true } };
      },
    }),
  );
  useTool(
    defineTool({
      name: 'bare_object',
      description: 'Returns a bare object (1.x style) to show the 2.x envelope rule.',
      input: v.object({}),
      // @ts-expect-error intentionally violating the 2.x return contract
      run: () => ({ a: 1 }),
    }),
  );
  useTool(
    defineTool({
      name: 'no_input',
      description: 'No input schema, bare string result.',
      run: () => 'ok-string',
    }),
  );

  return ctx?.persona ? `You are ${ctx.persona}.` : 'No persona loaded.';
}

Project.initialData = v.optional(
  v.object({
    model: v.optional(v.string()),
    d1: v.optional(v.object({ persona: v.nullable(v.string()), model: v.nullable(v.string()), memory: v.array(v.string()) })),
  }),
);
