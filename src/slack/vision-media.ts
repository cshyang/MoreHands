import type { D1Like } from '../skills/repository';
import type { SlackFileMeta } from './events';
import { isSlackConversationFileAllowed } from './file-authorizations';

export const VISION_IMAGE_MAX_BYTES = 4_000_000;
export const VISION_IMAGE_MAX_COUNT = 2;
const TURN_MAX_BYTES = 8_000_000;
const CANDIDATE_MAX_COUNT = 4;
const INFO_MAX_BYTES = 65_536;
export interface VisionImage { data: string; mimeType: string; filename?: string; fileId?: string }
export type VisionOmissionReason = 'unauthorized' | 'token-unavailable' | 'type-unknown' | 'unsupported-format'
  | 'mime-mismatch' | 'invalid-header' | 'too-large' | 'turn-budget' | 'image-limit'
  | 'unsafe-url' | 'redirect-limit' | 'timeout' | 'unavailable' | 'native-payload-limit';
export interface VisionPreparation {
  images: VisionImage[];
  omissions: Array<{ fileId: string; reason: VisionOmissionReason }>;
}
export function addSafeMediaNotices(input: Record<string, unknown>, preparation: VisionPreparation, supportsVision: boolean): Record<string, unknown> {
  const { mediaNotices: _notices, mediaCapabilityNotice: _capability, ...rest } = input;
  const files = [...(Array.isArray(input.attachedFiles) ? input.attachedFiles : []), ...(Array.isArray(input.historyFiles) ? input.historyFiles : [])];
  const hasImages = files.some(file => file && (!file.mimetype || String(file.mimetype).startsWith('image/')));
  return { ...rest,
    ...(preparation.omissions.length ? { mediaNotices: preparation.omissions.slice(0, 20).map(({ fileId, reason }) => ({ fileId, reason })) } : {}),
    ...(!supportsVision && hasImages ? { mediaCapabilityNotice: 'selected model does not accept images' } : {}),
  };
}
class MediaFailure extends Error {
  constructor(readonly reason: VisionOmissionReason) { super(reason); }
}
interface ByteBudget { used: number; cap: number }

async function readBounded(response: Response, cap: number, budget: ByteBudget, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new MediaFailure('unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new MediaFailure('timeout');
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new MediaFailure('timeout');
      if (done) break;
      budget.used += value.byteLength;
      const nextBytes = bytes + value.byteLength;
      if (nextBytes > cap || budget.used > budget.cap) {
        throw new MediaFailure(nextBytes > cap ? 'too-large' : 'turn-budget');
      }
      bytes = nextBytes; chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the safe failure. */ }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort); reader.releaseLock();
  }
}
function privateUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new MediaFailure('unsafe-url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password || url.port) {
    throw new MediaFailure('unsafe-url');
  }
  return url;
}
async function download(value: string, token: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  let url = privateUrl(value);
  for (let hops = 0; ; hops++) {
    const response = await fetcher(url.href, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (hops === 3) throw new MediaFailure('redirect-limit');
    const location = response.headers.get('location');
    if (!location) throw new MediaFailure('unsafe-url');
    url = privateUrl(location, url);
  }
}
function imageMime(bytes: Uint8Array): string {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && starts([137, 80, 78, 71, 13, 10, 26, 10])
    && view.getUint32(8) === 13 && ascii(12, 16) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(20) > 0) return 'image/png';
  if (starts([255, 216])) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0 || marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length >= 11 && bytes[offset + 7] > 0 && length === 8 + 3 * bytes[offset + 7]
          && view.getUint16(offset + 3) > 0 && view.getUint16(offset + 5) > 0) return 'image/jpeg';
        break;
      }
      offset += length;
    }
  }
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    && view.getUint16(6, true) > 0 && view.getUint16(8, true) > 0) return 'image/gif';
  if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const riffEnd = view.getUint32(4, true) + 8;
    const chunk = ascii(12, 16);
    const length = view.getUint32(16, true);
    if (riffEnd <= bytes.length && 20 + length + (length % 2) <= riffEnd) {
      if (chunk === 'VP8 ' && length >= 10 && bytes.length >= 30 && !(bytes[20] & 1)
        && ascii(23, 26) === '\u009d\u0001*' && (view.getUint16(26, true) & 0x3fff) > 0
        && (view.getUint16(28, true) & 0x3fff) > 0) return 'image/webp';
      if (chunk === 'VP8L' && length >= 5 && bytes.length >= 25 && bytes[20] === 0x2f
        && !(bytes[24] & 0xe0)) return 'image/webp';
      if (chunk === 'VP8X' && length === 10 && bytes.length >= 30) return 'image/webp';
    }
  }
  throw new MediaFailure('invalid-header');
}
export async function prepareVisionImages(input: {
  db: D1Like; token: string | undefined; projectId: string; conversationId: string;
  files: SlackFileMeta[]; fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<VisionPreparation> {
  const result: VisionPreparation = { images: [], omissions: [] };
  const seen = new Set<string>();
  const budget: ByteBudget = { used: 0, cap: TURN_MAX_BYTES };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(input.timeoutMs ?? 5_000, 5_000)));
  const fetcher = input.fetcher ?? fetch;
  let candidates = 0;
  try {
    for (const file of input.files) {
      if (!file.id || seen.has(file.id)) continue;
      seen.add(file.id);
      if (file.mimetype && !file.mimetype.startsWith('image/')) continue;
      try {
        if (!file.mimetype && !/\.(png|jpe?g|gif|webp)$/i.test(file.name ?? '')) throw new MediaFailure('type-unknown');
        if (file.mimetype && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype)) throw new MediaFailure('unsupported-format');
        if (!input.token) throw new MediaFailure('token-unavailable');
        if (controller.signal.aborted) throw new MediaFailure('timeout');
        if (budget.used >= budget.cap) throw new MediaFailure('turn-budget');
        if (result.images.length >= VISION_IMAGE_MAX_COUNT || candidates >= CANDIDATE_MAX_COUNT) throw new MediaFailure('image-limit');
        candidates++;
        if (!await isSlackConversationFileAllowed(input.db, { projectId: input.projectId, conversationId: input.conversationId, fileId: file.id })) {
          throw new MediaFailure('unauthorized');
        }
        const response = await fetcher(`https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`, {
          headers: { authorization: `Bearer ${input.token}` }, redirect: 'manual', signal: controller.signal,
        });
        if (!response.ok) { await response.body?.cancel(); throw new MediaFailure('unavailable'); }
        let info: { ok?: boolean; file?: { id?: string; url_private_download?: string; url_private?: string } };
        try {
          info = JSON.parse(new TextDecoder().decode(await readBounded(response, INFO_MAX_BYTES, { used: 0, cap: INFO_MAX_BYTES }, controller.signal)));
        } catch (error) {
          if (controller.signal.aborted) throw new MediaFailure('timeout');
          throw new MediaFailure('unavailable');
        }
        const url = info.file?.url_private_download ?? info.file?.url_private;
        if (!info.ok || info.file?.id !== file.id || typeof url !== 'string') throw new MediaFailure('unavailable');
        const media = await download(url, input.token, fetcher, controller.signal);
        if (!media.ok) { await media.body?.cancel(); throw new MediaFailure('unavailable'); }
        const responseMime = media.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (responseMime && responseMime !== 'application/octet-stream'
          && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(responseMime)) {
          await media.body?.cancel(); throw new MediaFailure('mime-mismatch');
        }
        const bytes = await readBounded(media, VISION_IMAGE_MAX_BYTES, budget, controller.signal);
        const mimeType = imageMime(bytes);
        if (responseMime && responseMime !== 'application/octet-stream' && responseMime !== mimeType) {
          throw new MediaFailure('mime-mismatch');
        }
        result.images.push({ fileId: file.id, data: Buffer.from(bytes).toString('base64'), mimeType, ...(file.name ? { filename: file.name } : {}) });
      } catch (error) {
        result.omissions.push({ fileId: file.id, reason: controller.signal.aborted ? 'timeout'
          : error instanceof MediaFailure ? error.reason : 'unavailable' });
      }
    }
    return result;
  } finally { clearTimeout(timer); }
}
