import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { sdkObservationFixture } from './observation-test-fixtures';
import { readSdkObservation } from './sdk-observation';
const { test, run } = createTestRunner();
for (const insert of [
  "INSERT INTO cf_agents_runs(id,name,created_at) VALUES('r','x',1)",
  "INSERT INTO cf_agents_facet_runs(owner_path,owner_path_key,run_id,created_at) VALUES('private-owner','opaque','r',1)",
  "INSERT INTO cf_agents_queues(id,callback) VALUES('q','private-callback')",
  "INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES('f','x','pending',1)",
  "INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES('f','x','running',1)",
  "INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at) VALUES('t','x','starting',1)",
  "INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at) VALUES('t','x','running',1)",
  "INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at,completed_at,child_still_running) VALUES('t','x','interrupted',1,2,1)",
  "INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at,completed_at,detached,finish_claimed_at) VALUES('t','x','completed',1,2,1,2)",
]) {
  test(`SDK durable recovery blocks: ${insert.split('(')[0]}`, () => {
    const f = sdkObservationFixture(); f.sql.exec(insert);
    const result = readSdkObservation(f.observationSql, '0.20.1');
    assert.ok(result.blockers.length > 0); assert.ok(f.queries.every(q => /^(SELECT|PRAGMA)\b/i.test(q.trim())));
    assert.ok(!JSON.stringify(result).includes('private-owner')); f.sql.close();
  });
}
for (const status of ['completed', 'aborted', 'interrupted', 'error']) {
  test(`retained terminal ${status} fiber is not outstanding work`, () => {
    const f = sdkObservationFixture(); f.sql.prepare('INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at,completed_at) VALUES(?,?,?,1,2)').run('f','x',status);
    const result = readSdkObservation(f.observationSql, '0.20.1');
    assert.equal(result.sdkStatuses.fibers?.[status], 1); assert.deepEqual(result.blockers, []); assert.deepEqual(result.unknowns, []); f.sql.close();
  });
}
for (const status of ['paused', 'waiting', 'running', 'unknown']) {
  test(`workflow ${status} cannot prove idle`, () => {
    const f = sdkObservationFixture(); f.sql.prepare('INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status) VALUES(?,?,?,?)').run('w','w','x',status);
    const result = readSdkObservation(f.observationSql, '0.20.1');
    assert.ok(result.blockers.length + result.unknowns.length > 0); f.sql.close();
  });
}
for (const mutation of [
  "UPDATE cf_agents_state SET state='9'", 'DROP TABLE cf_agents_runs',
  'ALTER TABLE cf_agent_tool_runs RENAME COLUMN detached TO missing',
  "INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES('f','x','secret-status',1)",
  "INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES('f','x','completed',1)",
  "INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at,completed_at) VALUES('t','x','interrupted',1,2)",
]) {
  test(`SDK missing proof is unknown: ${mutation.split('(')[0]}`, () => {
    const f = sdkObservationFixture(); f.sql.exec(mutation);
    const result = readSdkObservation(f.observationSql, '0.20.1'); assert.ok(result.unknowns.length > 0);
    assert.ok(!JSON.stringify(result).includes('secret-status')); f.sql.close();
  });
}
for (const callback of ['__flueWakeAgentSubmissions','reconcileReplies','private-callback',null]) {
  test(`remaining schedule blocks for callback ${callback}`, () => {
    const f = sdkObservationFixture();
    f.sql.prepare('INSERT INTO cf_agents_schedules(id,callback,type,time,owner_path,owner_path_key,payload) VALUES(?,?,\'delayed\',1,?,?,?)')
      .run('s',callback,'private-owner','opaque-owner','secret-payload');
    const result = readSdkObservation(f.observationSql, '0.20.1'); assert.ok(result.blockers.length > 0);
    if (!callback || callback === 'private-callback') assert.ok(result.unknowns.length > 0);
    assert.ok(!JSON.stringify(result).includes('private-')); assert.ok(!JSON.stringify(result).includes('secret-payload')); f.sql.close();
  });
}
test('schedule groups are bounded but total count is uncapped', () => {
  const f = sdkObservationFixture(); const insert = f.sql.prepare("INSERT INTO cf_agents_schedules(id,callback,type,time,owner_path,owner_path_key) VALUES(?,'reconcileReplies','cron',1,'[]',?)");
  for(let i=0;i<1002;i++) insert.run(`s${i}`,`owner-${i}`);
  const result = readSdkObservation(f.observationSql,'0.20.1'); assert.equal(result.counts.schedules,1002);
  assert.ok(result.schedules.length<=1000); assert.ok(result.unknowns.length>0); f.sql.close();
});
for (const type of ['scheduled', 'cron', 'interval', null, 'private-type']) {
  test(`schedule type ${type} remains outstanding and unknown types are redacted`, () => {
    const f = sdkObservationFixture();
    if (type === null || type === 'private-type') {
      // Corrupted/foreign schema with the expected columns, without SDK CHECKs.
      f.sql.exec('CREATE TABLE corrupted_schedules AS SELECT * FROM cf_agents_schedules; DROP TABLE cf_agents_schedules; ALTER TABLE corrupted_schedules RENAME TO cf_agents_schedules');
    }
    f.sql.prepare("INSERT INTO cf_agents_schedules(id,callback,type,time) VALUES('s','reconcileReplies',?,1)").run(type);
    const result = readSdkObservation(f.observationSql, '0.20.1');
    assert.ok(result.blockers.includes('sdk-schedules'));
    assert.equal(result.unknowns.includes('sdk-schedule-type'), type === null || type === 'private-type');
    assert.ok(!JSON.stringify(result).includes('private-type')); f.sql.close();
  });
}
for (const owner of ['Child:private-name', 'malformed-owner', '%ZZ:child', 'Child:one:two']) {
  test(`schedule owner ${owner} is validated without returning names`, () => {
    const f = sdkObservationFixture();
    f.sql.prepare("INSERT INTO cf_agents_schedules(id,callback,type,time,owner_path_key) VALUES('s','reconcileReplies','delayed',1,?)").run(owner);
    const result = readSdkObservation(f.observationSql, '0.20.1');
    assert.ok(result.blockers.includes('sdk-schedules'));
    assert.equal(result.unknowns.includes('sdk-schedule-owner'), owner !== 'Child:private-name');
    assert.ok(!JSON.stringify(result).includes(owner)); f.sql.close();
  });
}
await run();
