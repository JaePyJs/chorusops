import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, VoiceConnection } from '@discordjs/voice';
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

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

interface SendableChannel {
  send: (content: string) => Promise<any>;
}

interface GuildSession {
  connection: VoiceConnection;
  speechmatics: SpeechmaticsClient;
  activeConversationId: string;
  activeTextChannel: SendableChannel;
  activeUserStreams: Set<string>;
  userSpeakerMap: Map<string, string>;
  speakerCounter: number;
}

// Map of Guild ID → Active Session to support multi-guild isolation perfectly
const guildSessions = new Map<string, GuildSession>();

// Helper to safely split and send messages that exceed Discord's 2000-character limit (BUG B & BUG C)
async function sendLongMessage(target: Message | SendableChannel, text: string, useReply = false) {
  const maxLength = 1900;
  if (text.length <= maxLength) {
    if (target instanceof Message) {
      if (useReply) {
        await target.reply(text);
      } else {
        await (target.channel as SendableChannel).send(text);
      }
    } else {
      await target.send(text);
    }
    return;
  }

  const chunks: string[] = [];
  let currentChunk = '';
  const lines = text.split('\n');

  for (const line of lines) {
    // Edge case split: If a single line/paragraph itself exceeds maxLength, slice it explicitly
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      for (let j = 0; j < line.length; j += maxLength) {
        chunks.push(line.slice(j, j + maxLength));
      }
      continue;
    }

    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += (currentChunk ? '\n' : '') + line;
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && target instanceof Message && useReply) {
      await target.reply(chunks[i]);
    } else {
      if (target instanceof Message) {
        await (target.channel as SendableChannel).send(chunks[i]);
      } else {
        await target.send(chunks[i]);
      }
    }
  }
}

client.once(Events.ClientReady, c => {
  console.log(`[Discord Bot] Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  const guildId = message.guildId;
  if (!guildId) return; // Only process guild commands

  // Help command (BUG K)
  if (message.content.trim() === '!help') {
    await sendLongMessage(message, [
      `🤖 **Dealflow Orchestrator Bot — Command Guide**`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• \`!help\` — Displays this guide.`,
      `• \`!agent join\` — Invites the bot to your current voice channel to start listening.`,
      `• \`!agent say <text>\` — Interacts with the central Gemini orchestrator via text.`,
      `• \`!status <workflow_id>\` — Fetches a beautiful real-time dashboard of enqueued background analysis jobs.`,
      `• \`!agent leave\` — Orders the bot to disconnect from the voice channel and reset context.`,
    ].join('\n'), true);
    return;
  }

  // Join Voice Channel command
  if (message.content.startsWith('!agent join')) {
    const channel = message.member?.voice.channel;
    if (!channel) {
      message.reply('You need to join a voice channel first!');
      return;
    }

    if (!process.env.SPEECHMATICS_API_KEY) {
      message.reply('SPEECHMATICS_API_KEY not set. Voice transcription is disabled.');
      return;
    }

    // Clean up existing session in this guild if any
    const existingSession = guildSessions.get(guildId);
    if (existingSession) {
      existingSession.speechmatics.close();
      existingSession.connection.destroy();
      guildSessions.delete(guildId);
    }

    // Initialize a dedicated Speechmatics client for this specific guild session (BUG D & BUG E)
    const sessionSpeechmatics = new SpeechmaticsClient(process.env.SPEECHMATICS_API_KEY, async (transcript, speaker) => {
      const session = guildSessions.get(guildId);
      if (!session) return;

      try {
        const response = await axios.post(`${BACKEND_URL}/agent/invoke`, {
          conversationId: session.activeConversationId,
          text: transcript,
          speakerId: speaker,
          type: 'voice'
        });

        const agentText: string = response.data.response;
        const workflowId: string = response.data.workflowId;
        const enqueuedJobIds: string[] | undefined = response.data.enqueuedJobIds;

        let replyText = `**[${speaker}]** ${transcript}\n> 🤖 ${agentText}`;
        if (enqueuedJobIds && enqueuedJobIds.length > 0) {
          replyText += `\n> 📋 Job queued! Check status with: \`!status ${workflowId}\``;
        }

        await sendLongMessage(session.activeTextChannel, replyText);
        console.log(`[Discord Bot] Posted agent response to channel.`);
      } catch (error) {
        console.error('[Discord Bot] Error invoking agent:', error);
      }
    });

    sessionSpeechmatics.connect();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const activeUserStreams = new Set<string>();
    const userSpeakerMap = new Map<string, string>();

    guildSessions.set(guildId, {
      connection,
      speechmatics: sessionSpeechmatics,
      activeConversationId: message.channel.id,
      activeTextChannel: message.channel as SendableChannel,
      activeUserStreams,
      userSpeakerMap,
      speakerCounter: 1,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[Discord Bot] Joined voice channel ${channel.name}`);
      message.reply(`Joined voice channel **${channel.name}** and listening...`);

      const receiver = connection.receiver;

      receiver.speaking.on('start', (userId) => {
        const session = guildSessions.get(guildId);
        if (!session) return;

        // Guard against duplicate overlapping audio stream subscriptions (BUG A)
        if (session.activeUserStreams.has(userId)) {
          return;
        }
        session.activeUserStreams.add(userId);

        if (!session.userSpeakerMap.has(userId)) {
          session.userSpeakerMap.set(userId, `S${session.speakerCounter++}`);
          console.log(`[Discord Bot] Mapped user ${userId} → ${session.userSpeakerMap.get(userId)}`);
        }

        const opusStream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
        });

        const { opus } = require('prism-media');
        const pcmStream = opusStream.pipe(new opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 }));

        pcmStream.on('data', (chunk: Buffer) => {
          session.speechmatics.sendAudio(chunk);
        });

        pcmStream.on('error', (err: Error) => {
          console.error(`[Discord Bot] PCM decode error for user ${userId}:`, err.message);
        });

        const cleanup = () => {
          session.activeUserStreams.delete(userId);
          console.log(`[Discord Bot] Finished streaming audio for user ${userId}.`);
        };
        opusStream.on('end', cleanup);
        opusStream.on('close', cleanup);

        console.log(`[Discord Bot] User ${userId} (${session.userSpeakerMap.get(userId)}) started speaking.`);
      });
    });
    return;
  }

  // Leave Voice Channel command (BUG J)
  if (message.content.startsWith('!agent leave')) {
    const session = guildSessions.get(guildId);
    if (!session) {
      message.reply('I am not in a voice channel in this server.');
      return;
    }

    // Proactively close the websocket connection first to send EndOfStream and flush in-flight packets,
    // wait 200ms to avoid cutting off buffered data, and then destroy the voice channel connection.
    session.speechmatics.close();
    setTimeout(() => {
      session.connection.destroy();
    }, 200);
    guildSessions.delete(guildId);

    message.reply('Left voice channel and cleared active listening session.');
    return;
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
      if (enqueuedJobIds && enqueuedJobIds.length > 0) {
        reply += `\n\n📋 Job queued! Track it with: \`!status ${workflowId}\``;
      }
      
      await sendLongMessage(message, reply, true);
    } catch (error) {
      console.error(error);
      message.reply('Error talking to the agent backend.');
    }
    return;
  }

  // Handle status checks - fetches real workflow/job data from backend
  if (message.content.startsWith('!status')) {
    const workflowId = message.content.replace('!status', '').trim();
    
    if (!workflowId) {
      message.reply('Usage: \`!status <workflow_id>\` — You can find your workflow ID in the agent\'s responses.');
      return;
    }
    
    try {
      const response = await axios.get(`${BACKEND_URL}/agent/status/${workflowId}`);
      const { workflow, jobs } = response.data;
      
      const jobSummary = jobs.length > 0
        ? jobs.map((j: any) => {
            let detail = `• **${j.type}**: \`${j.status}\``;
            if (j.status === 'COMPLETED' && j.result) {
              const res = j.result as any;
              detail += ` ✅\n  > 🎯 **Score:** \`${res.score}/10\` | **Recommendation:** \`${res.recommendation}\`\n  > 📝 **Summary:** *${res.summary}*\n  > 🟢 **Pros:** ${res.pros?.join(', ') || 'None'}\n  > 🔴 **Cons:** ${res.cons?.join(', ') || 'None'}`;
            } else if (j.status === 'FAILED' && j.error) {
              detail += ` ❌\n  > ⚠️ **Error:** *${j.error}*`;
            }
            return detail;
          }).join('\n\n')
        : 'No background jobs enqueued.';
        
      const dealName = workflow.state?.dealName || 'Unknown Deal';
      const stageEmojiMap: Record<string, string> = {
        'initial': '💬',
        'gathering': '📝',
        'analysis_queued': '⏳',
        'analysis_done': '✨',
        'decision': '🏁',
      };
      const emoji = stageEmojiMap[workflow.state?.stage] || '🔄';

      const statusResponse = [
        `📊 **Dealflow Analysis: ${dealName}** (ID: \`${workflow.id.slice(0, 8)}\`)`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `● **Stage:** ${emoji} \`${workflow.state?.stage || 'N/A'}\``,
        `● **Status:** \`${workflow.status}\``,
        `● **Background Jobs:**\n${jobSummary}`,
      ].join('\n');

      await sendLongMessage(message, statusResponse, true);
    } catch (error) {
      message.reply('Could not fetch status. Make sure the workflow ID is correct.');
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
