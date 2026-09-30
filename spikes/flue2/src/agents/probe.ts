'use agent';
// Native-first audit probes (2026-09-30). Every agent logs to D1 so the Worker can read back.
//   Pa/Pf   : burst (message-joins-live-response) - Pa posts inside the tool, Pf posts at useAgentFinish
//   Hng     : hung tool, with and without tool timeoutMs, under durability.timeoutMs
//   Stall   : model stream that never yields (local stall server)
//   Sbx     : unconditional useSandbox with a recording factory
//   SbxC    : conditional useSandbox (flag in persistent state, flipped by a tool)
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  defineTool,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useModel,
  usePersistentState,
  useSandbox,
  useTool,
  type AgentProps,
  type Sandbox,
  type SandboxFactory,
} from '@flue/runtime';

const db = () => (env as any).DB as D1Database;

async function plog(instance: string, what: string, extra = '') {
  await db().prepare('INSERT INTO plog(instance_id, ts, what, extra) VALUES (?,?,?,?)').bind(instance, Date.now(), what, extra).run();
}

function modelOf(d: ReturnType<typeof useDelivery>, dflt: string): string {
  return (d.kind === 'signal' ? d.attributes?.model : undefined) ?? dflt;
}

// ---------------------------------------------------------------- burst
const BURST_PROMPT =
  'You are a chat agent. For each user question: call slow_step once (before answering), then call post_reply once with a short answer that addresses ALL questions you have seen so far. If you already replied and then see a new question, answer it with post_reply. Keep answers under 20 words.';

function burstTools(id: string, mode: 'inline' | 'finish') {
  const [stash, setStash] = usePersistentState<string | null>('stash', null);
  const [sent, setSent] = usePersistentState<number>('sent', 0);
  useTool(
    defineTool({
      name: 'slow_step',
      description: 'A slow lookup (about 10 seconds). Call once before answering.',
      input: v.object({}),
      run: async () => {
        await plog(id, 'slow_step:start');
        await new Promise((r) => setTimeout(r, 10_000));
        await plog(id, 'slow_step:end');
        return 'lookup done';
      },
    }),
  );
  useTool(
    defineTool({
      name: 'post_reply',
      description: 'Post the answer to the user.',
      input: v.object({ text: v.string() }),
      run: async ({ data }) => {
        if (mode === 'inline') {
          await plog(id, 'reply_posted', data.text);
          return 'posted';
        }
        setStash(data.text);
        await plog(id, 'reply_stashed', data.text);
        return 'queued; it will be delivered when you finish';
      },
    }),
  );
  if (mode === 'finish') {
    useAgentFinish(async ({ log }) => {
      if (stash) {
        await plog(id, 'reply_posted_at_finish', stash);
        setSent(sent + 1);
        setStash(null);
      }
    });
  }
  useAgentStart(async () => {
    await plog(id, 'agent_start');
  });
}

export function Pa({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  burstTools(id, 'inline');
  return BURST_PROMPT;
}
export function Pf({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  burstTools(id, 'finish');
  return BURST_PROMPT;
}

// ---------------------------------------------------------------- hang / stall
function hangTools(id: string) {
  useTool(
    defineTool({
      name: 'hang_plain',
      description: 'Looks up data. Always call this when asked to use hang_plain.',
      input: v.object({}),
      run: async () => {
        await plog(id, 'hang_plain:start');
        await new Promise(() => {}); // never settles, ignores signal
        return 'unreachable';
      },
    }),
  );
  useTool(
    defineTool({
      name: 'hang_bounded',
      description: 'Looks up data. Always call this when asked to use hang_bounded.',
      input: v.object({}),
      timeoutMs: 10_000,
      run: async () => {
        await plog(id, 'hang_bounded:start');
        await new Promise(() => {}); // never settles, ignores signal
        return 'unreachable';
      },
    }),
  );
  useTool(
    defineTool({
      name: 'post_reply',
      description: 'Post the final answer.',
      input: v.object({ text: v.string() }),
      run: async ({ data }) => {
        await plog(id, 'reply_posted', data.text);
        return 'posted';
      },
    }),
  );
}
const HANG_PROMPT = 'You are a test agent. Do exactly what the user asks about which tool to call. After any tool result, call post_reply with one short sentence and stop.';

export function Hng({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  hangTools(id);
  return HANG_PROMPT;
}
Hng.durability = { timeoutMs: 45_000, maxAttempts: 2 };

export function Stall({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'stall/m1'));
  hangTools(id);
  return HANG_PROMPT;
}
Stall.durability = { timeoutMs: 45_000, maxAttempts: 2 };

// ---------------------------------------------------------------- sandbox
function recordingFactory(id: string): SandboxFactory {
  const sb = (): Sandbox => {
    const note = (m: string) => void plog(id, `sbx:${m}`);
    const fake: any = {
      cwd: '/workspace',
      resolvePath: (p: string) => (p.startsWith('/') ? p : `/workspace/${p}`),
      async exec(cmd: string) { note(`exec ${cmd}`); return { stdout: '', stderr: '', exitCode: 0 }; },
      async readFile(p: string) { note(`readFile ${p}`); throw new Error('ENOENT'); },
      async readFileBuffer(p: string) { note(`readFileBuffer ${p}`); throw new Error('ENOENT'); },
      async writeFile(p: string) { note(`writeFile ${p}`); },
      async stat(p: string) { note(`stat ${p}`); throw new Error('ENOENT'); },
      async readdir(p: string) { note(`readdir ${p}`); return []; },
      async exists(p: string) { note(`exists ${p}`); return false; },
      async mkdir(p: string) { note(`mkdir ${p}`); },
      async rm(p: string) { note(`rm ${p}`); },
    };
    return fake as Sandbox;
  };
  return {
    async createSandbox({ id: iid }) {
      await plog(id, 'sbx:createSandbox', iid);
      return sb();
    },
  };
}
const SBX_PROMPT = 'You are a test agent. If asked to open the workspace, call open_workspace. Otherwise just answer in one short sentence, without any tool.';

export function Sbx({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  useSandbox(recordingFactory(id));
  return SBX_PROMPT;
}

export function SbxC({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  const [open, setOpen] = usePersistentState<boolean>('ws_open', false);
  useTool(
    defineTool({
      name: 'open_workspace',
      description: 'Open the workspace sandbox so you can run shell commands.',
      input: v.object({}),
      run: async () => {
        setOpen(true);
        await plog(id, 'flag_flipped');
        return 'workspace opened';
      },
    }),
  );
  if (open) useSandbox(recordingFactory(id));
  return SBX_PROMPT;
}

// ---------------------------------------------------------------- finish enforcement (replaces withReplyReminder)
export function Pr({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  useTool(
    defineTool({
      name: 'sign_off',
      description: 'Finalizer. Only call this when a system signal tells you to.',
      input: v.object({ text: v.string() }),
      run: async ({ data }) => {
        await plog(id, 'sign_off_called', data.text);
        return 'signed off';
      },
    }),
  );
  useAgentFinish(async ({ response, append }) => {
    const done = response.toolCalls.some((c) => c.tool === 'sign_off' && !c.isError);
    await plog(id, 'finish_hook', `signed=${done}`);
    if (!done) append({ kind: 'signal', type: 'signoff.missing', body: 'You have not signed off. Call sign_off now with your answer.' });
  });
  return 'Answer the question in one plain-text sentence. Do not call tools on your own.';
}

// ---------------------------------------------------------------- quick burst (no slow step), plain vs marker shim
// 'plain'  : post_reply posts immediately.
// 'marker' : the gateway wrote the newest message seq to D1 before dispatch; post_reply refuses while a
//            newer message than the delivery it is answering exists, so the newer one can join first.
function quickBurst(id: string, mode: 'plain' | 'marker') {
  const d = useDelivery();
  const seq = d.kind === 'signal' ? Number(d.attributes?.seq ?? 0) : 0;
  useTool(
    defineTool({
      name: 'post_reply',
      description: 'Post the answer to the user. Call once per answer.',
      input: v.object({ text: v.string() }),
      run: async ({ data }) => {
        if (mode === 'marker') {
          const row = await db().prepare('SELECT MAX(seq) AS m FROM marks WHERE instance_id=?').bind(id).first<{ m: number }>();
          if ((row?.m ?? 0) > seq) {
            await plog(id, 'reply_refused', `mark=${row?.m} delivery=${seq}`);
            return 'NOT SENT: a newer message arrived in this conversation. Do not reply yet; you will receive it next. Then answer everything in one reply.';
          }
        }
        await plog(id, 'reply_posted', data.text);
        return 'posted';
      },
    }),
  );
}
const QUICK_PROMPT = 'You are a chat agent. Answer each user message by calling post_reply exactly once per answer, with a short answer (under 15 words) that covers every question you have seen so far. Do not call any other tool.';
export function Pq({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  quickBurst(id, 'plain');
  return QUICK_PROMPT;
}
export function Ph({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  quickBurst(id, 'marker');
  return QUICK_PROMPT;
}

// 'accum': reply tool appends to a stash; useAgentFinish posts once when nothing is queued.
export function Pg({ id }: AgentProps) {
  const d = useDelivery();
  useModel(modelOf(d, 'zai/glm-5.3-flash'));
  const [stash, setStash] = usePersistentState<string[]>('stash_list', []);
  useTool(
    defineTool({
      name: 'post_reply',
      description: 'Queue the answer to the user. Call once per answer; everything queued is delivered together when you finish.',
      input: v.object({ text: v.string() }),
      run: async ({ data }) => {
        setStash((prev) => [...(prev ?? []), data.text]);
        await plog(id, 'reply_stashed', data.text);
        return 'queued; delivered when you finish';
      },
    }),
  );
  useAgentFinish(async () => {
    if (stash.length) {
      await plog(id, 'reply_posted_at_finish', stash.join(' | '));
      setStash([]);
    }
  });
  return QUICK_PROMPT;
}
