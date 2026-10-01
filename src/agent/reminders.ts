// Reminder tools (the "when"). Reminders live in the D1 `reminders` table; the minutely
// cron scan in .flue/cloudflare.ts fires due rows through /__internal/scheduled. (The
// external ticker worker's SchedulerDO is retired — Flue 0.11 hosts its own cron.)
// A reminder references a skill by NAME (or carries a one-off prompt) — never the skill
// body, so edits to the skill apply to all future scheduled runs (reference, not copy).

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { upsertReminder, listReminders, cancelReminder, setReminderEnabled } from '../gateway/reminders-store';

export function reminderTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  const store = (): D1Like => {
    if (!db) throw new Error('Reminders are unavailable (no DB binding).');
    return db;
  };

  const setReminder = defineTool({
    name: 'set_reminder',
    description:
      'Schedule future autonomous work for yourself. Give each reminder a stable `id` (reuse to replace, new to add). ' +
      'Pick ONE timing: `cron` (wall-clock in KL/UTC+8, 5 fields, e.g. "0 9 * * *" = 9am daily), `everyMs` (interval), ' +
      '`inMs` (once, after a delay), or `runAt` (once, at an epoch-ms time — use the "now" field to compute it). ' +
      'Point it at work with `skill` (name of one of your saved skills — loaded fresh each run) and/or `prompt` ' +
      '(a one-off instruction). When it fires you get a heartbeat turn carrying that skill/prompt.',
    input: v.object({
      id: v.pipe(v.string(), v.description('Stable reminder id, e.g. "daily-digest".')),
      cron: v.optional(v.pipe(v.string(), v.description('KL-time cron "min hour dom mon dow", e.g. "0 9 * * 1" = Mondays 9am.'))),
      everyMs: v.optional(v.pipe(v.number(), v.description('Recurring interval in ms.'))),
      inMs: v.optional(v.pipe(v.number(), v.description('One-shot delay from now, in ms.'))),
      runAt: v.optional(v.pipe(v.number(), v.description('One-shot absolute epoch-ms time.'))),
      skill: v.optional(v.pipe(v.string(), v.description('Name of a saved skill to run when this fires.'))),
      prompt: v.optional(v.pipe(v.string(), v.description('A one-off instruction for the run (with or instead of a skill).'))),
    }),
    async run({ data: { id, cron, everyMs, inMs, runAt, skill, prompt } }) {
      const set = await upsertReminder(store(), projectId, {
        id: String(id),
        kind: 'heartbeat',
        cron: cron ? String(cron) : undefined,
        everyMs: typeof everyMs === 'number' ? everyMs : undefined,
        inMs: typeof inMs === 'number' ? inMs : undefined,
        runAt: typeof runAt === 'number' ? runAt : undefined,
        payload: { skill, prompt },
      });
      return `reminder "${set.id}" set — next run ${new Date(set.nextRun).toISOString()} (UTC).`;
    },
  });

  const listRemindersTool = defineTool({
    name: 'list_reminders',
    description: 'List your scheduled reminders (id, timing, next run, paused state).',
    input: v.object({}),
    async run() {
      const jobs = await listReminders(store(), projectId);
      if (!jobs.length) return 'No reminders set.';
      return jobs
        .map((j) => {
          const when = j.cron ? `cron "${j.cron}"` : j.every_ms ? `every ${j.every_ms}ms` : 'once';
          const next = new Date(Number(j.next_run)).toISOString();
          return `• ${j.id} — ${when}, next ${next}${j.enabled ? '' : ' (paused)'}`;
        })
        .join('\n');
    },
  });

  const cancelReminderTool = defineTool({
    name: 'cancel_reminder',
    description: 'Delete a reminder by id (permanent).',
    input: v.object({ id: v.pipe(v.string(), v.description('Reminder id to cancel.')) }),
    async run({ data: { id } }) {
      await cancelReminder(store(), projectId, String(id));
      return `cancelled "${id}".`;
    },
  });

  const pauseReminder = defineTool({
    name: 'pause_reminder',
    description: 'Pause a reminder — keeps it but stops it firing, until you resume it.',
    input: v.object({ id: v.pipe(v.string(), v.description('Reminder id to pause.')) }),
    async run({ data: { id } }) {
      const res = await setReminderEnabled(store(), projectId, String(id), false);
      return res.found ? `paused "${id}".` : `no reminder named "${id}".`;
    },
  });

  const resumeReminder = defineTool({
    name: 'resume_reminder',
    description: 'Resume a paused reminder.',
    input: v.object({ id: v.pipe(v.string(), v.description('Reminder id to resume.')) }),
    async run({ data: { id } }) {
      const res = await setReminderEnabled(store(), projectId, String(id), true);
      return res.found ? `resumed "${id}".` : `no reminder named "${id}".`;
    },
  });

  return [setReminder, listRemindersTool, cancelReminderTool, pauseReminder, resumeReminder];
}
