import { requireColumns, observationCount, validCount, type ObservationSql, type SdkObservation } from './observation';

export function readSdkObservation(sql: ObservationSql, version: '0.15.0' | '0.20.1'): SdkObservation {
  const result: SdkObservation = { sdkSchemaVersion: null, sdkStatuses: {}, counts: {}, schedules: [], blockers: [], unknowns: [] };
  const tables: Record<string, string[]> = {
    cf_agents_state: ['id','state'], cf_agents_runs: ['id','name'],
    cf_agents_facet_runs: ['owner_path','owner_path_key','run_id'], cf_agents_queues: ['id','callback'],
    cf_agents_fibers: ['fiber_id','status','completed_at'], cf_agents_workflows: ['id','status','completed_at'],
    cf_agent_tool_runs: ['run_id','status','child_still_running','completed_at', ...(version === '0.20.1'
      ? ['detached','finish_claimed_at','finish_delivered_at','give_up_claimed_at','give_up_delivered_at'] : [])],
    cf_agents_schedules: ['id','callback','type','time','running','owner_path','owner_path_key'],
  };
  try {
    for (const [table, columns] of Object.entries(tables)) requireColumns(sql, table, columns);
    const stamp = sql.exec("SELECT state FROM cf_agents_state WHERE id='cf_schema_version'").toArray()[0]?.state;
    if (typeof stamp === 'string' && /^\d{1,3}$/.test(stamp)) result.sdkSchemaVersion = stamp;
    if (stamp !== (version === '0.20.1' ? '11' : '9')) result.unknowns.push('sdk-schema-version');
    for (const [table, key] of [['cf_agents_runs','runs'], ['cf_agents_facet_runs','facetRuns'], ['cf_agents_queues','queues']]) {
      result.counts[key] = observationCount(sql, `SELECT COUNT(*) AS count FROM ${table}`);
      if (result.counts[key]) result.blockers.push(`sdk-${key}`);
    }
    const groups = [
      { table: 'cf_agents_fibers', key: 'fibers', active: ['pending','running'], terminal: ['completed','aborted','interrupted','error'] },
      { table: 'cf_agents_workflows', key: 'workflows', active: ['queued','running','paused','waiting','waitingForPause'], terminal: ['complete','errored','terminated'] },
      { table: 'cf_agent_tool_runs', key: 'toolRuns', active: ['starting','running'], terminal: ['completed','error','aborted','interrupted'] },
    ];
    for (const { table, key, active, terminal } of groups) {
      result.counts[key] = observationCount(sql, `SELECT COUNT(*) AS count FROM ${table}`);
      const rows = sql.exec(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status LIMIT 1001`).toArray();
      const statuses: Record<string, number> = {}; result.sdkStatuses[key] = statuses;
      if (rows.length > 1000) result.unknowns.push(`sdk-${key}-overflow`);
      for (const row of rows.slice(0,1000)) {
        const count = validCount(row.count);
        if (typeof row.status !== 'string' || ![...active,...terminal].includes(row.status)) {
          result.unknowns.push(`sdk-${key}-status`); continue;
        }
        statuses[row.status] = count;
        if (active.includes(row.status) && count) result.blockers.push(`sdk-${key}-active`);
      }
      const terminalSql = terminal.map(status => `'${status}'`).join(',');
      if (observationCount(sql, `SELECT COUNT(*) AS count FROM ${table} WHERE status IN (${terminalSql})
        AND (completed_at IS NULL OR typeof(completed_at)<>'integer' OR completed_at<0)`)) result.unknowns.push(`sdk-${key}-completion`);
      result.counts[`${key}Unsuccessful`] = observationCount(sql, `SELECT COUNT(*) AS count FROM ${table} WHERE status IN ('error','errored','aborted','interrupted','terminated')`);
    }
    const liveChildren = observationCount(sql, "SELECT COUNT(*) AS count FROM cf_agent_tool_runs WHERE status='interrupted' AND (child_still_running IS NULL OR child_still_running<>0)");
    result.counts.unresolvedChildren = liveChildren;
    if (liveChildren) result.blockers.push('sdk-interrupted-child');
    if (observationCount(sql, "SELECT COUNT(*) AS count FROM cf_agent_tool_runs WHERE status='interrupted' AND child_still_running IS NULL")) result.unknowns.push('sdk-child-state');
    if (version === '0.20.1') {
      result.counts.detachedPending = observationCount(sql, 'SELECT COUNT(*) AS count FROM cf_agent_tool_runs WHERE detached=1 AND finish_delivered_at IS NULL');
      if (result.counts.detachedPending) result.blockers.push('sdk-detached-delivery');
    }
    result.counts.schedules = observationCount(sql, 'SELECT COUNT(*) AS count FROM cf_agents_schedules');
    if (result.counts.schedules) result.blockers.push('sdk-schedules');
    const schedules = sql.exec('SELECT callback,type,owner_path_key,COUNT(*) AS count FROM cf_agents_schedules GROUP BY callback,type,owner_path_key LIMIT 1001').toArray();
    if (schedules.length > 1000) result.unknowns.push('sdk-schedule-overflow');
    const ownerKeys = new Map<string, string>();
    for (const row of schedules.slice(0,1000)) {
      const knownCallback = row.callback === '__flueWakeAgentSubmissions' || row.callback === 'reconcileReplies';
      const knownType = ['scheduled','delayed','cron','interval'].includes(String(row.type));
      const owner = row.owner_path_key;
      if (!knownCallback) result.unknowns.push('sdk-schedule-callback');
      if (!knownType) result.unknowns.push('sdk-schedule-type');
      let ownerKey: string | null = null;
      if (owner !== null) {
        let valid = typeof owner === 'string' && owner.length > 0;
        try {
          valid = valid && (owner as string).split('/').every(step => {
            const parts = step.split(':');
            return parts.length === 2 && parts.every(part => part.length > 0 && encodeURIComponent(decodeURIComponent(part)) === part);
          });
        } catch { valid = false; }
        if (!valid) result.unknowns.push('sdk-schedule-owner');
        else {
          // SDK keys encode class/name paths, so expose only observation-local
          // labels while preserving grouping across callbacks for one owner.
          if (!ownerKeys.has(owner as string)) ownerKeys.set(owner as string, `owner-${ownerKeys.size + 1}`);
          ownerKey = ownerKeys.get(owner as string)!;
        }
      }
      result.schedules.push({ callback: knownCallback ? String(row.callback) : 'unknown', type: knownType ? String(row.type) : 'unknown',
        owner: ownerKey, count: validCount(row.count) });
    }
  } catch { result.unknowns.push('sdk-schema-or-read'); }
  result.blockers = [...new Set(result.blockers)]; result.unknowns = [...new Set(result.unknowns)];
  return result;
}
