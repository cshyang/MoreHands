// Valid 1×1 RGB-red PNG; external provider responses are deterministic local doubles.
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

export function providerResponse(): Response {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => ({
    id: 'local-image-answer', object: 'chat.completion.chunk', created: 0, model: 'glm-5.3-flash',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const events = [chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: 'local image answer' }, null), chunk({}, 'stop'),
    { ...chunk({}, 'stop'), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
