// Bundler resolves this placeholder to the freshly emitted native Worker main.
import worker, { FlueProjectAgent } from 'cutover-native-artifact';

export class LocalCanary extends FlueProjectAgent {
  async seedLocalWake() {
    await this.schedule(0, '__flueWakeAgentSubmissions', undefined, { idempotent: false });
    await this.schedule(0, 'reconcileReplies', undefined, { idempotent: false });
  }
}
export default {
  async fetch(request: Request, env: { TEST_AGENT: DurableObjectNamespace }) {
    if (new URL(request.url).pathname.startsWith('/public/')) {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice('/public'.length);
      let namespaceAccesses = 0;
      const forbiddenNamespace = new Proxy({}, { get() {
        namespaceAccesses++;
        throw new Error('public request must not access a Durable Object namespace');
      } });
      const response = await worker.fetch(new Request(url, request), {
        CUTOVER_CONTROL: 'd1', FLUE_PROJECT_AGENT: forbiddenNamespace, FLUE_REGISTRY: forbiddenNamespace,
      }, { waitUntil() { throw new Error('public request must not start deferred work'); } });
      const headers = new Headers(response.headers);
      headers.set('x-local-namespace-accesses', String(namespaceAccesses));
      return new Response(response.body, { status: response.status, headers });
    }
    if (new URL(request.url).pathname === '/identity') {
      const namespace = new Proxy({}, { get(_target, key) {
        if (key !== 'idFromName') throw new Error('identity derivation must not obtain a stub');
        return (name: string) => env.TEST_AGENT.idFromName(name);
      } });
      return worker.fetch(new Request('https://local/__admin/cutover/identities', {
        method: 'POST', headers: { 'x-morehands-admin-token': 'local-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ namespaceId: 'local-only', instanceNames: ['historical', 'local@g2'] }),
      }), { CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'local-only', ADMIN_CONNECTIONS_TOKEN: 'local-admin',
        FLUE_PROJECT_AGENT: namespace }, { waitUntil() { throw new Error('derivation must not start deferred work'); } });
    }
    const name = 'local@g2';
    const id = env.TEST_AGENT.idFromName(name);
    const stub = env.TEST_AGENT.get(id) as unknown as {
      setName(name: string): Promise<void>;
      seedLocalWake(): Promise<void>;
      observeCutover(identity: { namespaceId: string; objectId: string }): Promise<unknown>;
    };
    if (new URL(request.url).pathname === '/seed') {
      await stub.setName(name);
      await stub.seedLocalWake();
      return Response.json({ seeded: true });
    }
    return Response.json(await stub.observeCutover({ namespaceId: 'local-only', objectId: id.toString() }));
  },
};
