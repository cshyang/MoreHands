// Slack Events API envelope invariants — run: npx tsx src/slack/events.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import {
  parseSlackEventEnvelope,
  verifiedIngressEvent,
  slackEventId,
  slackUrlVerification,
  slackUserMessageEvent,
  isDirectMessage,
  type SlackEventEnvelope,
} from './events';

const { test, run } = createTestRunner();

test('parseSlackEventEnvelope: parses the raw Slack body', async () => {
  const body = parseSlackEventEnvelope('{"type":"event_callback","team_id":"T1"}');
  assert.equal(body.type, 'event_callback');
  assert.equal(body.team_id, 'T1');
});

test('slackUrlVerification: identifies Slack endpoint challenges', async () => {
  assert.deepEqual(slackUrlVerification({ type: 'url_verification', challenge: 'abc' }), { challenge: 'abc' });
  assert.equal(slackUrlVerification({ type: 'event_callback' }), null);
});

test('slackUserMessageEvent: accepts plain user messages with required routing fields', async () => {
  const event = slackUserMessageEvent({
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C1',
      ts: '111.222',
      thread_ts: '100.000',
      user: 'U1',
      text: '<@Ubot> hi',
    },
  });

  assert.deepEqual(event, {
    channel: 'C1',
    ts: '111.222',
    thread_ts: '100.000',
    user: 'U1',
    text: '<@Ubot> hi',
  });
});

test('slackUserMessageEvent: carries channel_type, and isDirectMessage detects DMs', async () => {
  const dm = slackUserMessageEvent({
    type: 'event_callback',
    event: { type: 'message', channel: 'D1', ts: '1.0', user: 'U1', text: 'hi', channel_type: 'im' },
  });
  assert.equal(dm?.channelType, 'im');
  assert.ok(isDirectMessage(dm!));

  const inChannel = slackUserMessageEvent({
    type: 'event_callback',
    event: { type: 'message', channel: 'C1', ts: '1.0', user: 'U1', text: 'hi', channel_type: 'channel' },
  });
  assert.equal(inChannel?.channelType, 'channel');
  assert.ok(!isDirectMessage(inChannel!));

  // No channel_type present → not a DM (no channelType key emitted).
  const bare = slackUserMessageEvent({ type: 'event_callback', event: { type: 'message', channel: 'C1', ts: '1.0', user: 'U1', text: 'hi' } });
  assert.equal(bare?.channelType, undefined);
  assert.ok(!isDirectMessage(bare!));
});

test('slackUserMessageEvent: ignores non-user messages and incomplete messages', async () => {
  const ignored: SlackEventEnvelope[] = [
    {},
    { event: { type: 'reaction_added', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', bot_id: 'B1', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', subtype: 'thread_broadcast', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', ts: '111.222' } },
    { event: { type: 'message', channel: 'C1' } },
  ];

  for (const body of ignored) {
    assert.equal(slackUserMessageEvent(body), null);
  }
});

test('slackUserMessageEvent: file_share messages pass with safe file metadata only', async () => {
  const event = slackUserMessageEvent({
    type: 'event_callback',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C1',
      ts: '111.222',
      user: 'U1',
      text: 'here is the sheet',
      files: [
        { id: 'F123', name: 'report.xlsx', mimetype: 'application/vnd.ms-excel', size: 1234 },
        // url_private and other fields must never survive parsing
        { id: 'F456', name: 'notes.txt', mimetype: 'text/plain', size: 10, url_private: 'https://files.slack.com/secret' } as never,
        { name: 'no-id-dropped.csv' },
      ],
    },
  });

  assert.deepEqual(event?.files, [
    { id: 'F123', name: 'report.xlsx', mimetype: 'application/vnd.ms-excel', size: 1234 },
    { id: 'F456', name: 'notes.txt', mimetype: 'text/plain', size: 10 },
  ]);
  assert.ok(!JSON.stringify(event).includes('url_private'));
  assert.ok(!JSON.stringify(event).includes('files.slack.com'));
});

test('slackUserMessageEvent: messages without files carry no files key; other subtypes still drop', async () => {
  const plain = slackUserMessageEvent({
    event: { type: 'message', channel: 'C1', ts: '1.2', user: 'U1', text: 'hi' },
  });
  assert.equal('files' in (plain ?? {}), false);

  const broadcast = slackUserMessageEvent({
    event: { type: 'message', subtype: 'thread_broadcast', channel: 'C1', ts: '1.2', files: [{ id: 'F1' }] },
  });
  assert.equal(broadcast, null);

  const botShare = slackUserMessageEvent({
    event: { type: 'message', subtype: 'file_share', bot_id: 'B1', channel: 'C1', ts: '1.2', files: [{ id: 'F1' }] },
  });
  assert.equal(botShare, null);
});

test('slackEventId: uses Slack event_id and falls back to channel timestamp', async () => {
  const event = { channel: 'C1', ts: '111.222' };
  assert.equal(slackEventId({ event_id: 'Ev1' }, event), 'Ev1');
  assert.equal(slackEventId({}, event), 'C1:111.222');
});

test('durable event digest covers original UTF-8 bytes while private fields are excluded', async () => {
  const body = { type: 'event_callback',team_id:'T',event_id:'E',api_app_id:'A',token:'private-value',
    event:{type:'message',channel:'C',ts:'1.0',user:'U',text:'世界🙂',files:[{id:'F',url_private:'https://private.invalid'}]}};
  const raw = JSON.stringify(body), event = slackUserMessageEvent(body)!;
  const selected = await verifiedIngressEvent(raw, body, event);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))).toString('hex');
  assert.equal(selected.digest, expected); assert.equal(selected.key,'T:E');
  assert.ok(!selected.eventJson.includes('private-value')); assert.ok(!selected.eventJson.includes('private.invalid'));
  assert.equal(JSON.parse(selected.eventJson).event.text,'世界🙂');
  assert.notEqual((await verifiedIngressEvent(raw+' ',body,event)).digest, selected.digest);
});
test('durable acceptance rejects ambiguous identity, invalid timestamps and oversized native keys', async () => {
  const body = { type:'event_callback',team_id:'T',event_id:'E',event:{type:'message',channel:'C',ts:'1.0',user:'U',text:'hello'}};
  for (const bad of [{...body,event_id:''},{...body,team_id:' T'},{...body,event_id:'x'.repeat(300)},
    {...body,event:{...body.event,ts:'1'}},{...body,event:{...body.event,text:{} as never}},
    {...body,event:{...body.event,thread_ts:'bad'}}]) {
    await assert.rejects(verifiedIngressEvent(JSON.stringify(bad),bad,slackUserMessageEvent(bad)!));
  }
});
await run();
