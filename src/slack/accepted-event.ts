import type { D1Like } from '../skills/repository';
import { bindings, loadBindings, bindingRecordToBinding, autoCreateBinding, agentInstanceId, type Binding } from '../project/bindings';
import { deploymentConfig, isKnownTeam } from '../config/deployment';
import { loadPersona } from '../project/persona';
import { upsertConversationTarget, loadAgentEpoch, conversationScope } from '../project/conversations';
import { normalizeSlackMessage } from '../shared/canonical';
import { agentPostedInConversation, logMessage } from '../knowledge/reflection';
import { isTrivialChatter, loadReviewState, answerBudgetFree, buildOverhearInstructions, overheardLine } from '../review';
import { mentionsBot, stripMention } from './mentions';
import { slackUserMessageEvent, isDirectMessage, type SlackEventEnvelope, type SlackFileMeta } from './events';
import { fetchThreadReplies, fetchChannelHistory, renderThreadBackscroll, slackMediaContext } from './threads';
import { recordSlackConversationFiles } from './file-authorizations';
import { findActiveSlackTurnActivity, loadSlackTurnActivity } from './activity';
import { pickWorkingAck } from './ack';
import { addReaction } from './post';
import { assignSoul } from '../project/souls';
import { ensureIngressAck } from './ingress-ack';
import { seedReplyTracker } from './delivery';
import { withWallClock } from '../shared/wall-clock';
import { readSlackIngress, updateLeasedIngress, leaseWhere, leaseValues, type IngressDb,
  type IngressLease, type IngressRow, type FrozenIngressRoute } from './ingress-store';
import { remainingIngressBudget, IngressBudgetDeferred } from './ingress-budget';
import type { ProjectDispatchRequest } from '../gateway/dispatch-message';

export type AcceptedEventPreparation = { kind: 'quiet' } | { kind: 'pending-ack'; retryAfterMs?: number }
  | { kind: 'native'; request: ProjectDispatchRequest; route: FrozenIngressRoute; ackMessageTs?: string };

/** Existing product helpers use fixed INSERT VALUES statements. Bind the live lease into
 * their writes so a check before an awaited call cannot become a stale unguarded effect. */
export function guardedIngressEffectsDb(db: IngressDb, lease: IngressLease, clock: () => number): D1Like {
  const tables = new Set(['bindings','skills','personas','conversation_targets','slack_conversation_files','messages','slack_reply_trackers','slack_turn_activity']);
  return { prepare: query => ({ bind: (...values) => {
    const statement = () => {
      const insert = query.match(/^\s*INSERT INTO (\w+)([\s\S]*?)VALUES\s*\(([\s\S]*?)\)\s*(ON CONFLICT[\s\S]*)?$/i);
      if (insert && tables.has(insert[1])) {
        if (/\(|\)/.test(insert[3])) throw new Error('Unsupported guarded product values');
        return db.prepare(`INSERT INTO ${insert[1]}${insert[2]} SELECT ${insert[3]}
          FROM slack_ingress WHERE ${leaseWhere(lease.phase)} ${insert[4] ?? ''}`)
          .bind(...values, ...leaseValues(lease, clock()));
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) throw new Error('Unsupported guarded product write');
      return db.prepare(query).bind(...values);
    };
    return { run: () => statement().run(), first: <T>() => statement().first<T>(), all: <T>() => statement().all<T>() };
  } }) };
}
async function slackBinding(db: D1Like, team: string, channel: string): Promise<Binding | undefined> {
  const seed = bindings.find(b => b.externalAccountId === team && b.externalSpaceId === channel && b.status === 'active');
  if (seed) return seed;
  const record = (await loadBindings(db)).find(b => b.externalAccountId === team && b.externalSpaceId === channel && b.status === 'active');
  return record ? bindingRecordToBinding(record) : undefined;
}
export async function prepareAcceptedSlackEvent(env: Record<string, unknown>, row: IngressRow, lease: IngressLease): Promise<AcceptedEventPreparation> {
  const db = env.DB as IngressDb;
  const clock = typeof env.__ingressClock === 'function' ? env.__ingressClock as () => number : Date.now;
  const effectsDb = guardedIngressEffectsDb(db, lease, clock);
  const body = JSON.parse(row.event_json) as SlackEventEnvelope, ev = slackUserMessageEvent(body);
  if (!ev || row.content_retention !== 'retained' || body.team_id !== row.team_id || body.event_id !== row.event_id) throw new Error('Accepted event identity unavailable');
  let route: FrozenIngressRoute | null = row.target_json ? JSON.parse(row.target_json) as FrozenIngressRoute : null;
  let binding = route ? route.binding ?? undefined : await slackBinding(effectsDb, row.team_id, ev.channel);
  if (!route && !binding && isKnownTeam(env, row.team_id) && mentionsBot(ev.text ?? '', deploymentConfig(env).slackBotId)) {
    const config = deploymentConfig(env);
    await autoCreateBinding(effectsDb, { teamId: row.team_id, channelId: ev.channel, transportBotId: config.slackBotId, transportTokenRef: config.slackTokenRef });
    binding = await slackBinding(effectsDb, row.team_id, ev.channel);
  }
  if (!binding) {
    if (!route) {
      route = { mode: 'quiet', deliveryEventId: `${row.team_id}:${row.event_id}`, epoch: 0,
        instanceId: null, target: null, binding: null, persona: null, skipAck: true };
      const changed = await db.prepare(`UPDATE slack_ingress SET target_json=?,mode='quiet',tracker_event_id=?,
        effects_complete=1,ack_state='skipped',updated_at=? WHERE ${leaseWhere('prepare')} AND target_json IS NULL
        AND NOT EXISTS(SELECT 1 FROM bindings WHERE external_account_id=? AND external_space_id=? AND status='active') RETURNING id`)
        .bind(JSON.stringify(route), route.deliveryEventId, clock(), ...leaseValues(lease, clock()), row.team_id, ev.channel).first();
      if (!changed) throw new Error('Quiet route selection lost its guard');
    }
    return { kind: 'quiet' };
  }
  const tokenValue = env[binding.transportTokenRef], token = typeof tokenValue === 'string' ? tokenValue : undefined;
  const text = ev.text ?? '', msg = normalizeSlackMessage(`${row.team_id}:${row.event_id}`, row.team_id,
    { ...ev, text: stripMention(text, binding.transportBotId) }, binding);
  const history = ev.thread_ts && token
    ? await withWallClock(fetchThreadReplies(token, ev.channel, ev.thread_ts), 10_000, 'Slack thread context').catch(() => [])
    : [];
  if (!route) {
    const engaged = mentionsBot(text, binding.transportBotId) || (isDirectMessage(ev) && (!!ev.files?.length || !isTrivialChatter(text)))
      || history.some(m => m.user === binding!.transportBotId)
      || (!!ev.thread_ts && await agentPostedInConversation(effectsDb, msg.projectId, msg.conversationId));
    let mode: FrozenIngressRoute['mode'] = engaged ? 'engaged' : 'quiet';
    if (!engaged && binding.overhear && !isDirectMessage(ev) && !isTrivialChatter(msg.text)
      && answerBudgetFree(await loadReviewState(effectsDb, msg.projectId), clock())) mode = 'overhear';
    await upsertConversationTarget(effectsDb, { projectId: msg.projectId, conversationId: msg.conversationId,
      provider: 'slack', externalAccountId: row.team_id, externalSpaceId: ev.channel,
      externalConversationId: msg.externalConversationId, transportTokenRef: binding.transportTokenRef });
    const epoch = await loadAgentEpoch(effectsDb, msg.projectId, msg.conversationId);
    let persona = mode !== 'quiet' ? await loadPersona(effectsDb, msg.projectId) : null;
    if (mode !== 'quiet' && !persona && await assignSoul(effectsDb, msg.projectId)) persona = await loadPersona(effectsDb, msg.projectId);
    const active = mode === 'engaged' ? await findActiveSlackTurnActivity(effectsDb, msg.projectId, msg.conversationId) : null;
    route = { mode, deliveryEventId: msg.providerEventId, epoch,
      instanceId: mode === 'quiet' ? null : agentInstanceId(msg.projectId, mode === 'overhear' ? `overhear:${ev.ts}` : conversationScope(msg.conversationId, epoch)),
      target: { projectId: msg.projectId, agentSlug: 'default', conversationId: msg.conversationId, provider: 'slack',
        externalAccountId: row.team_id, externalSpaceId: ev.channel, externalConversationId: msg.externalConversationId, transportTokenRef: binding.transportTokenRef },
      binding, persona, skipAck: mode !== 'engaged' || !!active,
      bindingSource: bindings.some(b => b === binding) ? 'seed' : 'database',
      ...(mode === 'overhear' ? { overhearNow: new Date(clock()).toISOString() } : {}) };
    const bindingGuard = route.bindingSource === 'seed' ? '1=1' : `EXISTS(SELECT 1 FROM bindings WHERE project_id=?
      AND provider='slack' AND external_account_id=? AND external_space_id=? AND transport_bot_id=? AND transport_token_ref=? AND status='active')`;
    const changed = await db.prepare(`UPDATE slack_ingress SET target_json=?,mode=?,instance_id=?,tracker_event_id=?,updated_at=?
      WHERE ${leaseWhere('prepare')} AND target_json IS NULL AND ${bindingGuard}
      AND EXISTS(SELECT 1 FROM conversation_targets WHERE project_id=? AND agent_slug='default' AND conversation_id=? AND agent_epoch=?) RETURNING id`)
      .bind(JSON.stringify(route), mode, route.instanceId, route.deliveryEventId, clock(), ...leaseValues(lease, clock()),
        ...(route.bindingSource === 'seed' ? [] : [binding.projectId, row.team_id, ev.channel, binding.transportBotId, binding.transportTokenRef]),
        msg.projectId, msg.conversationId, epoch).first();
    if (!changed) throw new Error('Route selection lost its guard');
  }
  if (route.mode === 'engaged' && route.skipAck && token) {
    await withWallClock(addReaction(token, ev.channel, ev.ts, 'eyes'), 1000, 'Slack joined reaction').catch(() => {});
  }
  let ackTs: string | undefined;
  if (route.skipAck) {
    if (!await updateLeasedIngress(db, lease, "ack_state='skipped'", [], clock())) throw new Error('Ack skip lost its guard');
  } else {
    const ackText = row.ack_json ? (JSON.parse(row.ack_json) as { text?: string }).text : undefined;
    const ack = await ensureIngressAck(db, lease, { ingressId: row.id, token, channel: ev.channel, threadTs: msg.externalConversationId,
      oldestTs: ev.ts, text: ackText ?? pickWorkingAck(), persona: route.persona,
      botId: binding.transportBotId, ...(body.api_app_id ? { appId: body.api_app_id } : {}) }, clock(), row);
    if (ack.status === 'rejected') throw new Error('Acknowledgement permanently rejected');
    if (ack.status === 'uncertain') return { kind: 'pending-ack' };
    if (ack.status === 'retryable-rejection') return { kind: 'pending-ack', retryAfterMs: ack.retryAfterMs };
    if (ack.status === 'posted') ackTs = ack.ts;
  }
  const fullHistory = route.mode === 'engaged' && !ev.thread_ts && token
    ? await withWallClock(fetchChannelHistory(token, ev.channel), 10_000, 'Slack channel context').catch(() => []) : history;
  const media = slackMediaContext(ev.files ?? [], fullHistory, ev.ts);
  const current = row; // this lease owns file checkpoints; ack/route writes do not change them
  const oldFiles = current.file_effects_json ? JSON.parse(current.file_effects_json) as SlackFileMeta[] : [];
  const files = [...oldFiles];
  for (const file of [...media.currentFiles, ...(route.mode === 'engaged' ? media.historyFiles : [])]) if (!files.some(f => f.id === file.id)) files.push(file);
  if (files.length && JSON.stringify(files) !== current.file_effects_json) {
    if (!await updateLeasedIngress(db, lease, 'file_effects_json=?,effects_complete=0', [JSON.stringify(files)], clock())) throw new Error('File effects lost their guard');
  }
  let cursor = current.file_effect_cursor;
  while (cursor < files.length) {
    const size = Math.min(10, files.length - cursor, remainingIngressBudget(db) - 5);
    if (size <= 0) throw new IngressBudgetDeferred();
    await recordSlackConversationFiles(effectsDb, { projectId: msg.projectId, conversationId: msg.conversationId,
      files: files.slice(cursor, cursor + size), now: clock });
    cursor += size;
    if (!await updateLeasedIngress(db, lease, 'file_effect_cursor=?', [cursor], clock())) throw new Error('File checkpoint lost its guard');
  }
  await logMessage(effectsDb, { projectId: msg.projectId, conversationId: msg.conversationId, senderId: msg.senderId, role: 'user',
    text: msg.text || (route.mode !== 'engaged' ? renderThreadBackscroll([{ user: ev.user, text: '', ts: ev.ts, files: ev.files }], binding.transportBotId) : ''),
    ambient: route.mode !== 'engaged', deliveryId: `ingress-transcript:${row.id}`, now: clock() });
  if (!await updateLeasedIngress(db, lease, 'effects_complete=1', [], clock())) throw new Error('Product completion lost its guard');
  if (route.mode === 'quiet') return { kind: 'quiet' };
  if (route.mode === 'engaged') {
    await seedReplyTracker(effectsDb, { instanceId: route.instanceId!, eventId: route.deliveryEventId, target: route.target!, persona: route.persona,
      ...(ackTs ? { ackMessageTs: ackTs } : {}), publish: true, now: clock() });
    const tracker = await db.prepare('SELECT target_json,persona_json,ack_message_ts,publish FROM slack_reply_trackers WHERE instance_id=? AND event_id=?')
      .bind(route.instanceId, route.deliveryEventId).first<{ target_json: string; persona_json: string | null; ack_message_ts: string | null; publish: number }>();
    if (!tracker || tracker.target_json !== JSON.stringify(route.target) || tracker.persona_json !== (route.persona ? JSON.stringify(route.persona) : null)
      || tracker.ack_message_ts !== (ackTs ?? null) || tracker.publish !== 1) throw new Error('Frozen reply tracker conflict');
    if (ackTs) {
      const session = `conv:${msg.conversationId}`, prior = await loadSlackTurnActivity(effectsDb, msg.projectId, session);
      if (prior && prior.ackMessageTs !== ackTs && prior.status === 'active') throw new Error('Different active turn owns receipt chrome');
      await db.prepare(`INSERT INTO slack_turn_activity(project_id,session_id,conversation_id,slack_channel_id,slack_thread_ts,
        ack_message_ts,transport_token_ref,status,activities_json,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,'active','[]',?,? FROM slack_ingress WHERE ${leaseWhere('prepare')}
        ON CONFLICT(project_id,session_id) DO UPDATE SET conversation_id=excluded.conversation_id,slack_channel_id=excluded.slack_channel_id,
          slack_thread_ts=excluded.slack_thread_ts,ack_message_ts=excluded.ack_message_ts,transport_token_ref=excluded.transport_token_ref,
          status='active',activities_json='[]',last_posted_at=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at,completed_at=NULL
        WHERE slack_turn_activity.status<>'active' AND slack_turn_activity.ack_message_ts<>excluded.ack_message_ts`)
        .bind(msg.projectId, session, msg.conversationId, ev.channel, msg.externalConversationId, ackTs, binding.transportTokenRef,
          clock(), clock(), ...leaseValues(lease, clock())).run();
    }
  }
  const backscroll = renderThreadBackscroll(fullHistory, binding.transportBotId, { excludeTs: ev.ts });
  const request: ProjectDispatchRequest = route.mode === 'overhear'
    ? { agent: 'project', id: route.instanceId!, eventId: route.deliveryEventId, idempotencyKey: `slack:${route.deliveryEventId}`,
      input: { kind: 'heartbeat', now: route.overhearNow!, instructions: buildOverhearInstructions(overheardLine(msg.conversationId, msg.senderId, msg.text)) } }
    : { agent: 'project', id: route.instanceId!, eventId: route.deliveryEventId, idempotencyKey: `slack:${route.deliveryEventId}`,
      input: { message: msg.text, conversationId: msg.conversationId, provider: 'slack', accountId: row.team_id, senderId: msg.senderId,
        ...(ackTs ? { ackMessageTs: ackTs } : {}), ...(backscroll ? (ev.thread_ts ? { threadContext: backscroll } : { channelContext: backscroll }) : {}),
        ...(media.historyFiles.length ? { historyFiles: media.historyFiles } : {}), ...(ev.files?.length ? { attachedFiles: ev.files } : {}) },
      ...(media.imageCandidates.length ? { imageFiles: media.imageCandidates } : {}) };
  return { kind: 'native', request, route, ...(ackTs ? { ackMessageTs: ackTs } : {}) };
}
