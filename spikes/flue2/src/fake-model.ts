// Scripted fake models so the spike needs no API keys and no network.
// Two providers: 'faux' (paced, ~real streaming) and 'fast' (unpaced burst, worst case for journal size).
// Directives are read from the last user/tool message text:
//   TOOLS      -> first call emits tool calls, the call after the tool results emits a short text
//   LONG:<n>   -> a text response of n characters
//   THINK      -> emits a thinking block before text
//   (default)  -> short "ack" text
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

function textOf(m: any): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n');
  return '';
}

// All user-role text after the last assistant message (framework narration signals are user-role too).
function lastUserText(messages: any[]): string {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role !== 'assistant'; i--) if (messages[i]?.role === 'user') out.push(textOf(messages[i]));
  return out.join('\n');
}

function make(id: string, opts: { tokensPerSecond?: number }) {
  const faux = fauxProvider({
    provider: id,
    models: [
      { id: 'model-a', contextWindow: 1_000_000, maxTokens: 64_000 },
      { id: 'model-b', contextWindow: 1_000_000, maxTokens: 64_000 },
    ],
    tokenSize: { min: 4, max: 4 }, // 16-char chunks
    ...(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond } : {}),
  });
  const factory: FauxResponseFactory = (context) => {
    const messages = context.messages as any[];
    const last = messages[messages.length - 1];
    faux.appendResponses([factory]); // infinite script
    if (last?.role === 'toolResult') return fauxAssistantMessage(fauxText('after-tools'));
    const u = lastUserText(messages);
    console.log(`[faux ${id}] last=${last?.role} user=${JSON.stringify(u).slice(0, 120)} roles=${messages.map((m) => m.role).join(',')}`);
    if (u.includes('ERR429')) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: '429 Too Many Requests: rate limit exceeded' });
    if (u.includes('ERR400')) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: '400 invalid request: bad payload' });
    const long = u.match(/LONG:(\d+)/);
    if (long) {
      const n = Number(long[1]);
      const blocks = u.includes('THINK') ? [fauxThinking('thinking '.repeat(40)), fauxText('x'.repeat(n))] : [fauxText('x'.repeat(n))];
      return fauxAssistantMessage(blocks);
    }
    if (u.includes('TOOLS')) {
      return fauxAssistantMessage([
        fauxToolCall('who_am_i', {}, { id: 'call_who' }),
        fauxToolCall('save_memory', { fact: 'saved-by-tool' }, { id: 'call_save' }),
        fauxToolCall('bare_object', {}, { id: 'call_bare' }),
        fauxToolCall('no_input', {}, { id: 'call_noinput' }),
      ]);
    }
    return fauxAssistantMessage(fauxText('ack'));
  };
  faux.setResponses([factory]);
  setProvider(faux.provider);
  return faux;
}

let done = false;
export function ensureFakeModels() {
  if (done) return;
  done = true;
  make('faux', { tokensPerSecond: 60 }); // 60 tok/s * 4 chars = 240 chars/s
  make('mid', { tokensPerSecond: 5000 }); // ~20KB/s, ~1250 deltas/s
  make('fast', {});
}
