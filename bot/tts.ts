import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnection,
} from '@discordjs/voice';
import { Readable } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const TTS_BASE_URL = process.env.TTS_BASE_URL || 'http://localhost:3001/api/v1';
const TTS_API_KEY = process.env.TTS_API_KEY || 'chorusops';
const TTS_VOICE = process.env.TTS_VOICE || 'af_heart';
const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

/**
 * Strips markdown, truncates to 2 sentences / 200 chars max.
 * Voice should be short, punchy, natural — full response goes to text channel.
 */
export function extractSpokenText(fullResponse: string): string {
  const cleaned = fullResponse
    .replace(/```[\s\S]*?```/g, '')        // strip code blocks
    .replace(/`[^`]+`/g, '')               // strip inline code
    .replace(/\*+([^*]+)\*+/g, '$1')       // strip bold/italic
    .replace(/#+\s/g, '')                  // strip markdown headers
    .replace(/>\s/g, '')                   // strip blockquotes
    .replace(/\[System\][^\n]*/g, '')      // strip system annotations
    .replace(/\n+/g, ' ')
    .trim();

  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  return sentences.slice(0, 2).join(' ').slice(0, 200).trim();
}

/**
 * Calls local Kokoro-Web (OpenAI-compatible TTS API) and returns an MP3 stream.
 * Kokoro-Web is self-hosted via Docker — zero rate limits, zero API cost.
 */
async function fetchKokoroStream(text: string): Promise<Readable> {
  const res = await fetch(`${TTS_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TTS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: TTS_VOICE,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    throw new Error(`Kokoro TTS request failed: ${res.status} ${res.statusText}`);
  }

  return Readable.fromWeb(res.body as any);
}

/**
 * Speaks text in the guild's active voice channel.
 * Silent no-op if TTS_ENABLED=false or connection is unavailable.
 * Errors are caught and logged — bot never crashes due to TTS failure.
 */
export async function speakInChannel(connection: VoiceConnection, text: string): Promise<void> {
  if (!TTS_ENABLED) return;
  if (!text || text.trim().length === 0) return;

  try {
    console.log(`[TTS] Speaking: "${text}"`);
    const stream = await fetchKokoroStream(text);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(resource);

    await new Promise<void>((resolve, reject) => {
      player.once(AudioPlayerStatus.Idle, resolve);
      player.once('error', (err) => {
        console.error('[TTS] AudioPlayer error:', err.message);
        resolve(); // resolve not reject — keep bot alive
      });
    });
  } catch (err) {
    console.error('[TTS] Failed to speak in channel:', err);
    // Silent fallback — text channel still gets the full response
  }
}
