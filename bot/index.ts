import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
import dotenv from 'dotenv';
import axios from 'axios';
import { SpeechmaticsClient } from './speechmatics';
// prism-media is required inline (CJS) to access the opus decoder at runtime.

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const BACKEND_URL = 'http://localhost:3000';

let speechmatics: SpeechmaticsClient | null = null;
let activeConversationId: string | null = null;
// Fix #6: Store a reference to the text channel so voice transcripts can be posted back there.
let activeTextChannel: import('discord.js').TextChannel | null = null;

// Maps Discord userId → Speechmatics speaker label (S1, S2, etc.) for per-speaker attribution in state.
const userSpeakerMap: Map<string, string> = new Map();
let speakerCounter = 1;

client.once(Events.ClientReady, c => {
  console.log(`[Discord Bot] Ready! Logged in as ${c.user.tag}`);
});

// Setup Speechmatics and handle text relay to backend
function initSpeechmatics() {
  if (!process.env.SPEECHMATICS_API_KEY) {
    console.warn('[Discord Bot] SPEECHMATICS_API_KEY not set. Voice transcription will be disabled.');
    return;
  }

  speechmatics = new SpeechmaticsClient(process.env.SPEECHMATICS_API_KEY, async (transcript, speaker) => {
    if (!activeConversationId) return;

    try {
      const response = await axios.post(`${BACKEND_URL}/agent/invoke`, {
        conversationId: activeConversationId,
        text: transcript,
        speakerId: speaker,
        type: 'voice'
      });

      const agentText: string = response.data.response;
      const workflowId: string = response.data.workflowId;
      const enqueuedJobIds: string[] | undefined = response.data.enqueuedJobIds;

      // Build the reply text, always tagging the workflowId for status checking
      let replyText = `**[${speaker}]** ${transcript}\n> 🤖 ${agentText}`;
      if (enqueuedJobIds && enqueuedJobIds.length > 0) {
        replyText += `\n> 📋 Job queued! Check status with: \`!status ${workflowId}\``;
      }

      // Post to the text channel — this is how voice responses reach Discord users
      if (activeTextChannel) {
        await activeTextChannel.send(replyText);
      }
      console.log(`[Discord Bot] Posted agent response to channel.`);
    } catch (error) {
      console.error('[Discord Bot] Error invoking agent:', error);
    }
  });

  speechmatics.connect();
}

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!agent join')) {
    const channel = message.member?.voice.channel;
    if (!channel) {
      message.reply('You need to join a voice channel first!');
      return;
    }

    activeConversationId = message.channel.id;
    // Fix #6: Store the text channel so voice transcript responses can be posted here
    activeTextChannel = message.channel as import('discord.js').TextChannel;
    if (!speechmatics) initSpeechmatics();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[Discord Bot] Joined voice channel ${channel.name}`);
      message.reply('Joined voice channel and listening...');

      const receiver = connection.receiver;

      receiver.speaking.on('start', (userId) => {
        // Assign a stable speaker label to this Discord user for Speechmatics diarization attribution.
        if (!userSpeakerMap.has(userId)) {
          userSpeakerMap.set(userId, `S${speakerCounter++}`);
          console.log(`[Discord Bot] Mapped user ${userId} → ${userSpeakerMap.get(userId)}`);
        }

        // Subscribe to the user's audio stream (Opus encoded from Discord)
        const opusStream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
        });

        // Decode Opus → PCM s16le at 48kHz, 1 channel using prism-media.
        // Speechmatics RT expects: raw PCM, 48000 Hz, mono, s16le.
        const { opus } = require('prism-media');
        const pcmStream = opusStream.pipe(new opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));

        pcmStream.on('data', (chunk: Buffer) => {
          speechmatics?.sendAudio(chunk);
        });

        pcmStream.on('error', (err: Error) => {
          console.error(`[Discord Bot] PCM decode error for user ${userId}:`, err.message);
        });

        console.log(`[Discord Bot] User ${userId} (${userSpeakerMap.get(userId)}) started speaking.`);
      });
    });
  }

  // Handle text interaction with agent
  if (message.content.startsWith('!agent say')) {
    const text = message.content.replace('!agent say', '').trim();
    if (!text) return;

    try {
      const response = await axios.post(`${BACKEND_URL}/agent/invoke`, {
        conversationId: message.channel.id,
        text,
        speakerId: message.author.username,
        type: 'text'
      });
      const workflowId: string = response.data.workflowId;
      const enqueuedJobIds: string[] | undefined = response.data.enqueuedJobIds;
      
      let reply = response.data.response as string;
      // Fix #6: When a job is enqueued, echo the workflowId explicitly so !status is usable
      if (enqueuedJobIds && enqueuedJobIds.length > 0) {
        reply += `\n\n📋 Job queued! Track it with: \`!status ${workflowId}\``;
      }
      message.reply(reply);
    } catch (error) {
      console.error(error);
      message.reply('Error talking to the agent backend.');
    }
  }

  // Handle status checks - fetches real workflow/job data from backend
  if (message.content.startsWith('!status')) {
    const workflowId = message.content.replace('!status', '').trim();
    
    if (!workflowId) {
      message.reply('Usage: `!status <workflow_id>` — You can find your workflow ID in the agent\'s responses.');
      return;
    }
    
    try {
      const response = await axios.get(`${BACKEND_URL}/agent/status/${workflowId}`);
      const { workflow, jobs } = response.data;
      
      const jobSummary = jobs.length > 0
        ? jobs.map((j: any) => `• ${j.type}: **${j.status}**${j.result ? ' ✅' : ''}`).join('\n')
        : 'No jobs yet.';
        
      message.reply([
        `**Workflow ${workflow.id.slice(0, 8)}...**`,
        `Stage: ${workflow.state?.stage || 'N/A'} | Status: ${workflow.status}`,
        `Deal: ${workflow.state?.dealName || 'Unknown'}`,
        `**Jobs:**\n${jobSummary}`,
      ].join('\n'));
    } catch (error) {
      message.reply('Could not fetch status. Make sure the workflow ID is correct.');
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
