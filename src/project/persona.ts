// Channel persona — the structured display identity (name + avatar) the agent's Slack
// posts appear under. The hatching/rewrite flow sets it via the set_persona tool; the post
// layer reads it for every fresh chat.postMessage. chat.update inherits the identity a
// message was posted with, so the ack→reply edit chain keeps the persona automatically.
// Needs the chat:write.customize scope on the Slack app; src/slack/post.ts degrades to the
// app's default name when the scope is missing.
//
// Avatar is EITHER an emoji (iconEmoji, ":owl:") OR an image URL (iconUrl, public https
// PNG/JPG — e.g. a DiceBear avatar seeded with the persona name). Slack prefers the emoji
// when both are sent, so set_persona replaces both fields on every call and the identity
// helper emits exactly one.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';

export interface Persona {
  name: string;
  iconEmoji: string | null;
  iconUrl: string | null;
}

// Slack truncates long usernames; keep names chat-sized.
export const PERSONA_NAME_MAX = 40;
const ICON_EMOJI_RE = /^:[a-z0-9_+'-]+:$/;
const ICON_URL_MAX = 512;

export async function loadPersona(db: D1Like, projectId: string): Promise<Persona | null> {
  const row = await db
    .prepare('SELECT name, icon_emoji, icon_url FROM personas WHERE project_id=?')
    .bind(projectId)
    .first<{ name: string; icon_emoji: string | null; icon_url: string | null }>();
  return row ? { name: row.name, iconEmoji: row.icon_emoji ?? null, iconUrl: row.icon_url ?? null } : null;
}

export async function setPersona(
  db: D1Like,
  projectId: string,
  input: { name: string; iconEmoji?: string | null; iconUrl?: string | null },
  updatedBy = 'agent',
): Promise<Persona> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('persona requires a non-empty name');
  if (name.length > PERSONA_NAME_MAX) throw new Error(`persona name exceeds ${PERSONA_NAME_MAX} characters`);
  const iconEmoji = input.iconEmoji ? String(input.iconEmoji).trim() : null;
  if (iconEmoji && !ICON_EMOJI_RE.test(iconEmoji)) {
    throw new Error('icon_emoji must be Slack emoji syntax like ":owl:"');
  }
  const iconUrl = input.iconUrl ? String(input.iconUrl).trim() : null;
  if (iconUrl && (!iconUrl.startsWith('https://') || iconUrl.length > ICON_URL_MAX)) {
    throw new Error(`icon_url must be an https:// image URL under ${ICON_URL_MAX} characters`);
  }
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO personas(project_id, name, icon_emoji, icon_url, updated_by, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET
         name=excluded.name,
         icon_emoji=excluded.icon_emoji,
         icon_url=excluded.icon_url,
         updated_by=excluded.updated_by,
         updated_at=excluded.updated_at`,
    )
    .bind(projectId, name, iconEmoji, iconUrl, updatedBy, now, now)
    .run();
  return { name, iconEmoji, iconUrl };
}

/** The chat.postMessage identity fields for a persona. Emits at most ONE icon field —
 *  Slack silently prefers icon_emoji over icon_url, so sending both invites confusion. */
export function personaIdentity(persona: Persona | null | undefined): { username?: string; iconEmoji?: string; iconUrl?: string } {
  if (!persona) return {};
  return {
    username: persona.name,
    ...(persona.iconEmoji ? { iconEmoji: persona.iconEmoji } : persona.iconUrl ? { iconUrl: persona.iconUrl } : {}),
  };
}

export function personaTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  const store = (): D1Like => {
    if (!db) throw new Error('Persona is unavailable (no DB binding).');
    return db;
  };

  const setPersonaTool = defineTool({
    name: 'set_persona',
    description:
      'Set the display identity your Slack messages appear under (name + avatar). Call this when you ' +
      'hatch, and again whenever the channel renames you — alongside saving your personality skill. ' +
      'Avatar: pass iconEmoji (":owl:") OR iconUrl (a public https PNG, e.g. a DiceBear avatar ' +
      '"https://api.dicebear.com/9.x/thumbs/png?seed=<YourName>" — deterministic per seed, no hosting). ' +
      'Each call replaces the whole identity, so include the avatar every time. People still summon you ' +
      'by @mentioning the app (that handle never changes); this only controls how your posts render.',
    input: v.object({
      name: v.pipe(v.string(), v.description('Display name, e.g. "Wren". Short — it appears on every message.')),
      iconEmoji: v.optional(v.pipe(v.string(), v.description('Emoji avatar in Slack syntax, e.g. ":owl:". Wins over iconUrl if both are set.'))),
      iconUrl: v.optional(v.pipe(v.string(), v.description('Image avatar: public https PNG/JPG URL, e.g. "https://api.dicebear.com/9.x/thumbs/png?seed=Wren".'))),
    }),
    async run({ data: { name, iconEmoji, iconUrl } }) {
      const p = await setPersona(store(), projectId, {
        name: String(name),
        iconEmoji: iconEmoji ? String(iconEmoji) : null,
        iconUrl: iconUrl ? String(iconUrl) : null,
      });
      const avatar = p.iconEmoji ?? p.iconUrl ?? 'app default icon';
      return `persona set — your posts will appear as "${p.name}" (avatar: ${avatar}) from the next turn.`;
    },
  });

  return [setPersonaTool];
}
