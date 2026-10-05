declare module 'ingress-native-artifact' {
  export class FlueProjectAgent {
    constructor(ctx: DurableObjectState, env: Record<string, unknown>);
    fetch(request: Request): Promise<Response>;
  }
  export class FlueRegistry {
    constructor(ctx: DurableObjectState, env: Record<string, unknown>);
    fetch(request: Request): Promise<Response>;
  }
  const worker: { fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> };
  export default worker;
}
