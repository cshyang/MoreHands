import { requireColumns, observationCount, validCount, type ObservationStorage, type ObservationIdentity, type InstanceObservation } from './observation';
import { readSdkObservation } from './sdk-observation';

export async function readNativeObservation(storage: ObservationStorage, identity: ObservationIdentity, now = Date.now()): Promise<InstanceObservation> {
  const result: InstanceObservation = { ...identity, generation: 'g2', runtimeVersion: '2.2.2', sdkVersion: '0.20.1', observedAt: now,
    format: null, status: 'unknown', nativeStatuses: {}, alarm: null,
    ...readSdkObservation(storage.sql, '0.20.1'), limitations: [
      'Matching-runtime constructor/startup recovery may execute before this read-only method.',
      'Observation is not an atomic cross-storage or fleet snapshot; observed idle is not deployment authorization.',
    ] };
  const sql = storage.sql;
  try {
    requireColumns(sql, 'flue_meta', ['key','value']);
    const format = sql.exec("SELECT value FROM flue_meta WHERE key='format_version'").toArray()[0]?.value;
    if (format === '1') result.format = { key: 'format_version', value: '1' };
    else result.unknowns.push('native-format');
    requireColumns(sql, 'flue_agent_submissions', ['submission_id','status','settled_at','error','canonical_ready_at','attempt_id',
      'input_applied_at','abort_requested_at','started_at','joined_into','attempt_count','max_attempts','timeout_at',
      'owner_id','lease_expires_at','settlement_record_id','settlement_record']);
    result.counts.nativeSubmissions = observationCount(sql, 'SELECT COUNT(*) AS count FROM flue_agent_submissions');
    const rows = sql.exec('SELECT status,COUNT(*) AS count FROM flue_agent_submissions GROUP BY status LIMIT 1001').toArray();
    if (rows.length > 1000) result.unknowns.push('native-status-overflow');
    for (const row of rows.slice(0,1000)) {
      const count = validCount(row.count);
      if (typeof row.status !== 'string' || !['queued','running','terminalizing','settled','joining','joined'].includes(row.status)) {
        result.unknowns.push('native-status'); continue;
      }
      result.nativeStatuses[row.status] = count;
      if (row.status !== 'settled' && count) result.blockers.push('native-unsettled');
    }
    if (observationCount(sql, "SELECT COUNT(*) AS count FROM flue_agent_submissions WHERE status='settled' AND (settled_at IS NULL OR typeof(settled_at)<>'integer' OR settled_at<0)")) {
      result.unknowns.push('native-settlement-marker');
    }
    result.counts.nativeErrors = observationCount(sql, "SELECT COUNT(*) AS count FROM flue_agent_submissions WHERE status='settled' AND error IS NOT NULL");
  } catch { result.unknowns.push('native-schema-or-read'); }
  try {
    const alarm = await storage.getAlarm();
    if (alarm !== null && (!Number.isSafeInteger(alarm) || alarm < 0)) result.unknowns.push('physical-alarm-invalid');
    else { result.alarm = alarm; if (alarm !== null) result.blockers.push('physical-alarm'); }
  } catch { result.unknowns.push('physical-alarm-read'); }
  try { if (await storage.get('cf_agents_destroy_pending') !== undefined) result.blockers.push('destroy-pending'); }
  catch { result.unknowns.push('destroy-pending-read'); }
  result.status = result.blockers.length ? 'blocked' : result.unknowns.length ? 'unknown' : 'observed-idle';
  return result;
}
