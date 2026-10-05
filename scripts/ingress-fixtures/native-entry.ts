// Resolve only to the actual emitted artifact, preserving its runtime registry.
import worker, { FlueProjectAgent, FlueRegistry } from 'ingress-native-artifact';

export { FlueRegistry };

export type FixtureInterruptPoint =
  | 'ready-before-native'
  | 'native-accept-before-receipt'
  | 'acknowledged-before-recovery'
  | 'prepare-lease-competition';

interface FixtureControl {
  point?: FixtureInterruptPoint;
  reached: boolean;
  released: boolean;
}

const control: FixtureControl = { reached: false, released: true };

function arm(point: FixtureInterruptPoint): void {
  control.point = point;
  control.reached = false;
  control.released = point !== 'prepare-lease-competition';
}

function markReached(): void {
  control.reached = true;
}

function disarm(): void {
  control.released = true;
  control.point = undefined;
  control.reached = false;

}

async function released(): Promise<void> {
  // Timer promises belong to the suspended request. Resolving one request's
  // promise from another request would cancel the original Workerd continuation.
  const deadline = Date.now() + 30_000;
  while (!control.released) {
    if (Date.now() >= deadline) throw new Error('fixture publication hold timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function eventFromDelivery(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const delivery = message as { kind?: unknown; body?: unknown; attributes?: { eventId?: unknown } };
  if (delivery.kind === 'user' && typeof delivery.body === 'string') {
    try {
      const envelope = JSON.parse(delivery.body) as { trusted?: { eventId?: unknown } };
      return typeof envelope.trusted?.eventId === 'string' ? envelope.trusted.eventId : undefined;
    } catch { return undefined; }
  }
  return typeof delivery.attributes?.eventId === 'string' ? delivery.attributes.eventId : undefined;
}

export class LocalIngressAgent extends FlueProjectAgent {
  private readonly fixtureCtx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.fixtureCtx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__flue/internal/dispatch') {
      const point = control.point;
      const response = await super.fetch(request);
      if (point === 'native-accept-before-receipt') {
        markReached();
        throw new Error('fixture lost native acceptance response');
      }
      return response;
    }
    return super.fetch(request);
  }

  async nativeEvidence(root: string): Promise<unknown> {
    const rows = this.fixtureCtx.storage.sql.exec(
      "SELECT submission_id,status,payload FROM flue_agent_submissions WHERE kind='dispatch' ORDER BY sequence"
    ).toArray() as Array<{ submission_id: string; status: string; payload: unknown }>;
    return rows.map(row => {
      const payloadText = String(row.payload);
      let eventId: string | undefined;
      try {
        const payload = JSON.parse(payloadText) as { message?: unknown };
        eventId = eventFromDelivery(payload.message);
      } catch { eventId = undefined; }
      return { submissionId: row.submission_id, status: row.status, eventId };
    });
  }
}

function faultAfterCommit(point: FixtureInterruptPoint, query: string): boolean {
  if (point === 'ready-before-native' && /^UPDATE slack_ingress SET manifest_id=/i.test(query.trim())) return true;
  return point === 'acknowledged-before-recovery'
    && /^UPDATE slack_ingress SET ack_state='posted',ack_message_ts=/i.test(query.trim());
}

function holdPublicationCompetition(point: FixtureInterruptPoint, query: string): boolean {
  return point === 'prepare-lease-competition'
    && /^UPDATE slack_ingress SET effects_complete=1/i.test(query.trim());
}

function faultDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            const shouldFault = () => control.point !== undefined && faultAfterCommit(control.point, query);
            return new Proxy(bound, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (typeof value !== 'function' || !['first', 'all', 'run', 'raw'].includes(String(property))) return value;
                return async (...arguments_: unknown[]) => {
                  const result = await Reflect.apply(value as (...input: unknown[]) => unknown, target, arguments_);
                  if (control.point !== undefined && holdPublicationCompetition(control.point, query)) {
                    markReached();
                    await released();
                  }
                  if (shouldFault()) {
                    markReached();
                    throw new Error('fixture interrupt after committed SQL boundary: ' + String(control.point));
                  }
                  return result;
                };
              },
            });
          },
        };
      };
    },
  });
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
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
      if (url.pathname === '/fixture/interrupt' && request.method === 'POST') {
        const body = await request.json() as { point?: unknown };
        const points = ['ready-before-native','native-accept-before-receipt',
          'acknowledged-before-recovery','prepare-lease-competition'];
        if (typeof body.point !== 'string' || !points.includes(body.point)) {
          return Response.json({ error: 'invalid fixture interrupt' }, { status: 400 });
        }
        arm(body.point as FixtureInterruptPoint);
        return Response.json({ ok: true, point: body.point });
      }
      if (url.pathname === '/fixture/release' && request.method === 'POST') {
        control.released = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === '/fixture/disarm' && request.method === 'POST') {
        disarm();
        return Response.json({ ok: true });
      }
      if (url.pathname === '/fixture/barrier') {
        return Response.json({ point: control.point ?? null, reached: control.reached });
      }
      if (url.pathname === '/fixture/native-evidence') {
        const namespace = env.FLUE_PROJECT_AGENT as DurableObjectNamespace;
        const root = url.searchParams.get('root');
        if (!root || !/^\d+\.\d+$/.test(root)) return Response.json({ error: 'invalid conversation root' }, { status: 400 });
        const name = 'project:P:agent:default/conv:slack:T:C:' + root + '@g2';
        const stub = namespace.get(namespace.idFromName(name)) as unknown as { nativeEvidence(root: string): Promise<unknown> };
        return Response.json(await stub.nativeEvidence(root));
      }
      return Response.json({ error: 'unknown ingress fixture route' }, { status: 404 });
    }

    return worker.fetch(request, { ...env, DB: faultDb(env.DB as D1Database) }, ctx);
  },
};
