import WebSocket from 'ws';
import axios from 'axios';

export class SpeechmaticsClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private onTranscript: (transcript: string, speaker: string) => void;

  constructor(apiKey: string, onTranscript: (transcript: string, speaker: string) => void) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
  }

  async connect() {
    const url = 'wss://us2.rt.speechmatics.com/v2/en';
    
    // In a real app we'd request a temporary JWT, but for hackathon API key might be accepted directly or we fetch JWT
    // const jwt = await this.getJwt();
    // this.ws = new WebSocket(`${url}?jwt=${jwt}`);
    
    // Mock WebSocket for the sake of the hackathon boilerplate if no real key is set
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    this.ws.on('open', () => {
      console.log('[Speechmatics] WebSocket connected.');
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
          max_delay: 5
        }
      };
      this.ws?.send(JSON.stringify(startMessage));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.message === 'AddTranscript') {
        const transcript = msg.metadata.transcript;
        // In RT, speaker information is in msg.results if diarization is enabled
        const speaker = msg.results?.[0]?.alternatives?.[0]?.speaker || 'Unknown';
        
        if (transcript && transcript.trim().length > 0) {
          console.log(`[Speechmatics] Transcript: ${speaker} - ${transcript}`);
          this.onTranscript(transcript, speaker);
        }
      } else if (msg.message === 'EndOfTranscript') {
        console.log('[Speechmatics] End of transcript reached.');
      } else if (msg.message === 'Error') {
        console.error('[Speechmatics] Error:', msg.reason);
      }
    });

    this.ws.on('close', () => {
      console.log('[Speechmatics] WebSocket closed.');
    });
  }

  sendAudio(pcmData: Buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmData);
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}
