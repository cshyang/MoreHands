// set_overhearing: the agent's self-service switch for Layer 4 v2. When a user asks it to "start
// watching this channel and chime in when you can help" (or to stop), the agent flips the
// per-binding overhear flag here — no operator, no redeploy. Enabling it means: from now on the
// agent evaluates every non-trivial message in THIS channel on receipt and replies (within a daily
// budget) when it can genuinely help, without an @mention. DMs are always engaged, so the flag is
// a no-op there.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { setBindingOverhear } from './bindings';

export function overhearingTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  if (!db) return [];
  return [
    defineTool({
      name: 'set_overhearing',
      description:
        'Turn proactive overhearing ON or OFF for THIS channel. When ON, you evaluate every message ' +
        "here as it arrives and reply (within a daily budget) when you can genuinely help — without being " +
        '@mentioned. Use this only when a user explicitly asks you to start (or stop) chiming in unprompted ' +
        'on this channel. Default is OFF (you only respond when @mentioned or following up in your own thread).',
      input: v.object({
        enabled: v.pipe(v.boolean(), v.description('true = start overhearing this channel; false = stop.')),
      }),
      async run({ data: { enabled } }) {
        const on = enabled === true;
        await setBindingOverhear(db, projectId, on);
        return on
          ? "Overhearing is ON for this channel — I'll chime in when I can genuinely help, even without an @mention (within my daily budget). Ask me to stop anytime."
          : "Overhearing is OFF for this channel — I'll only respond when @mentioned or following up in a thread I'm already in.";
      },
    }),
  ];
}
