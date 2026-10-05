// Resolve only to the actual emitted artifact, preserving its runtime registry.
import worker, { FlueProjectAgent, FlueRegistry } from 'image-native-artifact';
export { FlueRegistry };
const imageCompletionStatements = new WeakSet<object>();
const imageReceiptLossKey = 'fixture:lost-image-completion';
export class LocalImageAgent extends FlueProjectAgent {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    // Explicit fixture reconciliation controls delivery; native alarms stay gated until then.
    super(ctx, env);
  }
  async reconcileReplies() {
    if (!await this.ctx.storage.get('fixture-release-replies')) return [];
    return super.reconcileReplies();
  }
  async releaseReplies() {
    await this.ctx.storage.put('fixture-release-replies', true);
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname === '/__flue/internal/dispatch') {
      const body = await request.clone().text();
      await this.ctx.storage.put('fixture-request-size', { codeUnits: body.length, bytes: new TextEncoder().encode(body).length });
    }
    return super.fetch(request);
  }
  async requestSize() { return this.ctx.storage.get('fixture-request-size'); }
  async imageEvidence() {
    const rows = this.ctx.storage.sql.exec("SELECT payload FROM flue_agent_submissions WHERE kind='dispatch' ORDER BY sequence").toArray();
    return rows.map((row: { payload: unknown }) => {
      const payload = String(row.payload);
      const admitted = JSON.parse(payload);
      const envelope = admitted.message.kind === 'user' ? JSON.parse(admitted.message.body) : null;
      return { codeUnits: payload.length, bytes: new TextEncoder().encode(payload).length,
        kind: admitted.message.kind, eventId: envelope?.trusted?.eventId,
        mediaNotices: (envelope?.input ?? JSON.parse(admitted.message.body)).mediaNotices,
        snapshotFields: Object.keys(envelope?.trusted?.snapshot ?? {}),
        transportTokenRef: envelope?.trusted?.snapshot?.binding?.transportTokenRef };
    });
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/public/')) {
      url.pathname = url.pathname.slice('/public'.length);
      let accesses = 0;
      const namespace = new Proxy({}, { get() { accesses++; throw new Error('public namespace access'); } });
      const response = await worker.fetch(new Request(url, request), {
        ...env, FLUE_PROJECT_AGENT: namespace, FLUE_REGISTRY: namespace,
      }, ctx);
      const headers = new Headers(response.headers);
      headers.set('x-local-namespace-accesses', String(accesses));
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith('/fixture/')) {
      const namespace = env.FLUE_PROJECT_AGENT as DurableObjectNamespace;
      const name = 'project:P:agent:default/conv:slack:T:C:1.0@g2';
      const stub = namespace.get(namespace.idFromName(name)) as unknown as {
        observeCutover(identity: { namespaceId: string; objectId: string }): Promise<unknown>;
        imageEvidence(): Promise<unknown>;
        requestSize(): Promise<unknown>;
        releaseReplies(): Promise<void>;
        reconcileReplies(): Promise<unknown>;
      };
      if (url.pathname === '/fixture/reconcile') {
        await stub.releaseReplies();
        return Response.json(await stub.reconcileReplies());
      }
      if (url.pathname === '/fixture/request-size') return Response.json(await stub.requestSize());
      if (url.pathname === '/fixture/evidence') return Response.json(await stub.imageEvidence());
      return Response.json(await stub.observeCutover({ namespaceId: 'local-only', objectId: namespace.idFromName(name).toString() }));
    }
    const db = env.DB as D1Database;
    const fixtureEvents = env.SLACK_EVENTS as KVNamespace;
    const receiptLossDb = new Proxy(db, { get(target, property) {
      if (property === 'batch') {
        return async (statements: unknown[]) => {
          if (statements.some(statement => imageCompletionStatements.has(statement as object))
              && !(await fixtureEvents.get(imageReceiptLossKey))) {
            await fixtureEvents.put(imageReceiptLossKey, 'lost before product completion');
            throw new Error('local lost image receipt before product completion');
          }
          return await target.batch(statements as any[]);
        };
      }
      if (property !== 'prepare') {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    return (query: string) => {
      const statement = db.prepare(query);
      if (!query.startsWith('UPDATE slack_reply_trackers SET submission_id=')) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => {
          const bound = statement.bind(...values);
          if (values[4] === 'T:image') imageCompletionStatements.add(bound);
          return bound;
        };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
    } });
    return worker.fetch(request, { ...env, DB: receiptLossDb }, ctx);
  },
};
