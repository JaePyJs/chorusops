import WebSocket from 'ws';

// Auth note (from docs.speechmatics.com/introduction/authentication):
// Server-side RT connections authenticate via "Authorization: Bearer API_KEY" header.
// JWT/temp keys are for CLIENT-SIDE (browser) connections where the API key can't be exposed.
// For this Node.js bot, the API key as Bearer is the correct and documented approach.

interface SpeechmaticsMessage {
  message: string;
  id?: string;
  metadata?: {
    transcript: string;
  };
  results?: Array<{
    alternatives?: Array<{
      speaker?: string;
    }>;
  }>;
  time?: number;
  type?: string;
  reason?: string;
}

export class SpeechmaticsClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private onTranscript: (transcript: string, speaker: string) => void;
  private isConnected = false;

  // Segment buffering to ensure Gemini receives a complete spoken turn (SMART_TURN)
  // rather than triggering LLM invocations prematurely on partial sentences.
  private transcriptBuffer: string[] = [];
  private lastSpeaker = 'S1';

  constructor(apiKey: string, onTranscript: (transcript: string, speaker: string) => void) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
  }

  connect() {
    // Server-side auth: API key as Bearer token in WebSocket handshake header.
    // Endpoint format: wss://<region>.rt.speechmatics.com/v2
    const url = 'wss://eu2.rt.speechmatics.com/v2';

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('[Speechmatics] WebSocket connected. Sending StartRecognition...');

      // SMART_TURN equivalent configuration per turn-detection docs:
      //   - end_of_utterance_silence_trigger: 0.5s → fires EndOfUtterance after 0.5s of silence
      //     Note: This parameter belongs nested under conversation_config inside transcription_config.
      //   - enable_partials: false → no mid-word AddPartialTranscript events sent to us
      //   - diarization: 'speaker' → AddTranscript includes per-word speaker labels (S1, S2, ...)
      //   - max_delay: 5 → server must emit a final transcript within 5s regardless
      const startMessage = {
        message: 'StartRecognition',
        audio_format: {
          type: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 48000,
        },
        transcription_config: {
          language: 'en',
          operating_point: 'enhanced',
          enable_partials: false,
          diarization: 'speaker',
          max_delay: 5,
          // 0.5s of silence triggers end of utterance — recommended for voice AI (docs: 0.5-0.8s)
          conversation_config: {
            end_of_utterance_silence_trigger: 0.5,
          },
        },
      };

      this.ws?.send(JSON.stringify(startMessage));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      let msg: SpeechmaticsMessage;
      try {
        msg = JSON.parse(data.toString()) as SpeechmaticsMessage;
      } catch {
        return; // Binary frame (audio ack), ignore
      }

      switch (msg.message) {
        case 'RecognitionStarted': {
          this.isConnected = true;
          console.log('[Speechmatics] Recognition started. Session ID:', msg.id);
          break;
        }

        case 'AddTranscript': {
          // Final transcript segment. We buffer it instead of passing to the LLM immediately.
          // This ensures that the user is able to finish speaking their entire thought before we respond.
          const transcript: string = msg.metadata?.transcript ?? '';
          if (!transcript.trim()) break;

          // Speaker label from diarization (S1, S2, ...)
          // Falls back to 'S1' if diarization data is absent.
          const speaker: string = msg.results?.[0]?.alternatives?.[0]?.speaker ?? 'S1';

          console.log(`[Speechmatics] Segment [${speaker}]: ${transcript.trim()}`);
          this.transcriptBuffer.push(transcript.trim());
          this.lastSpeaker = speaker;
          break;
        }

        case 'AddPartialTranscript': {
          // Mid-speech partial — log for visibility but never trigger LLM.
          const partial: string = msg.metadata?.transcript ?? '';
          if (partial.trim()) {
            console.log(`[Speechmatics] Partial: ${partial.trim()}`);
          }
          break;
        }

        case 'EndOfUtterance': {
          // Fires after end_of_utterance_silence_trigger seconds of silence.
          // This is the correct event to flush all buffered segments as a single speaker turn.
          console.log(`[Speechmatics] EndOfUtterance at ${msg.time}s`);
          this.flushBuffer();
          break;
        }

        case 'EndOfTranscript': {
          console.log('[Speechmatics] Session ended (EndOfTranscript).');
          this.isConnected = false;
          this.flushBuffer();
          break;
        }

        case 'Error': {
          console.error(`[Speechmatics] Server error: ${msg.type} — ${msg.reason}`);
          break;
        }

        case 'Warning': {
          console.warn(`[Speechmatics] Warning: ${msg.type} — ${msg.reason}`);
          break;
        }
      }
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      console.log(`[Speechmatics] WebSocket closed. Code: ${code}, Reason: ${reason?.toString() || 'none'}`);
      this.flushBuffer();
    });

    this.ws.on('error', (err) => {
      console.error('[Speechmatics] WebSocket error:', err.message);
    });
  }

  private flushBuffer() {
    if (this.transcriptBuffer.length > 0) {
      const fullTurn = this.transcriptBuffer.join(' ');
      this.transcriptBuffer = [];
      console.log(`[Speechmatics] Flushing complete turn [${this.lastSpeaker}]: ${fullTurn}`);
      this.onTranscript(fullTurn, this.lastSpeaker);
    }
  }

  sendAudio(pcmData: Buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmData);
    }
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send EndOfStream so the server flushes any buffered audio before closing
      this.ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: 0 }));
      this.ws.close();
    }
  }
}
