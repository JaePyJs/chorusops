import { Client, GatewayIntentBits, Events, Message, SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, VoiceConnection } from '@discordjs/voice';
import dotenv from 'dotenv';
import axios from 'axios';
import { SpeechmaticsClient } from './speechmatics';
import { Job } from '../backend/db';
import { speakInChannel, extractSpokenText, warmupKokoro } from './tts';
// prism-media is required inline (CJS) to access the opus decoder at runtime.

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Displays the Dealflow Orchestrator guide'),
  new SlashCommandBuilder().setName('join').setDescription('Invites the bot to your current voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Orders the bot to disconnect from the voice channel'),
  new SlashCommandBuilder().setName('new').setDescription('Starts a brand-new, fresh deal workspace in this voice session'),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Interacts with the central Gemini orchestrator via text')
    .addStringOption(option => option.setName('text').setDescription('The text to say').setRequired(true)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Shows workflow stage, job status, and analysis results')
    .addStringOption(option => option.setName('workflow_id').setDescription('The ID of the workflow to check').setRequired(true)),
  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Enable or disable bot voice responses')
    .addBooleanOption(option => option.setName('enabled').setDescription('Set to true to talk, false to stay silent').setRequired(true)),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Select the bot voice model')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Pick a neural voice model')
        .setRequired(true)
        .addChoices(
          { name: 'Heart (Female - Default)', value: 'af_heart' },
          { name: 'Bella (Female)', value: 'af_bella' },
          { name: 'Nicole (Female)', value: 'af_nicole' },
          { name: 'Sarah (Female)', value: 'af_sarah' },
          { name: 'Adam (Male)', value: 'am_adam' },
          { name: 'Michael (Male)', value: 'am_michael' },
          { name: 'Fenrir (Male)', value: 'am_fenrir' }
        )
    )
].map(command => command.toJSON());

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
  send: (content: string) => Promise<unknown>;
}

interface GuildSession {
  connection: VoiceConnection;
  speechmatics: SpeechmaticsClient;
  activeConversationId: string;
  activeTextChannel: SendableChannel;
  activeUserStreams: Set<string>;
  userSpeakerMap: Map<string, string>;
  speakerCounter: number;
  ttsEnabled: boolean;
  ttsVoice: string;
  pendingWorkflows?: Set<string>;
}

// Map of Guild ID → Active Session to support multi-guild isolation perfectly
const guildSessions = new Map<string, GuildSession>();

// Helper to safely split and send messages that exceed Discord's 2000-character limit (BUG B & BUG C)
async function sendLongMessage(target: Message | ChatInputCommandInteraction | SendableChannel, text: string, useReply = false) {
  const maxLength = 1900;
  
  const sendFirst = async (content: string) => {
    if (useReply && 'reply' in target) {
      if ('deferred' in target) { // Interaction
        if ((target as ChatInputCommandInteraction).deferred || (target as ChatInputCommandInteraction).replied) {
          await (target as ChatInputCommandInteraction).followUp(content);
        } else {
          await (target as ChatInputCommandInteraction).reply(content);
        }
      } else { // Message
        await (target as Message).reply(content);
      }
    } else if ('channel' in target && target.channel) {
      await (target.channel as SendableChannel).send(content);
    } else if ('send' in target) {
      await (target as SendableChannel).send(content);
    }
  };

  const sendNext = async (content: string) => {
    if ('channel' in target && target.channel) {
      await (target.channel as SendableChannel).send(content);
    } else if ('send' in target) {
      await (target as SendableChannel).send(content);
    }
  };

  if (text.length <= maxLength) {
    await sendFirst(text);
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
    if (i === 0) {
      await sendFirst(chunks[i]);
    } else {
      await sendNext(chunks[i]);
    }
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`[Discord Bot] Ready! Logged in as ${c.user.tag}`);
  try {
    if (process.env.DISCORD_BOT_TOKEN) {
      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
      console.log('[Discord Bot] Started refreshing application (/) commands.');
      for (const guild of c.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: commands });
      }
      console.log('[Discord Bot] Successfully reloaded application (/) commands.');
      await warmupKokoro();
    }
  } catch (error) {
    console.error('[Discord Bot] Failed to register slash commands:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Commands can only be used in a server.', ephemeral: true });
    return;
  }

  const commandName = interaction.commandName;

  // Help command
  if (commandName === 'help') {
    await sendLongMessage(interaction, [
      `**Dealflow Orchestrator — Interface Command Guide**`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• \`/help\` — Displays this guide.`,
      `• \`/new\` — Starts a brand-new, fresh deal workspace in this voice session.`,
      `• \`/join\` — Invites the bot to your current voice channel to start listening.`,
      `• \`/tts <true/false>\` — Enables or disables voice synthesis / speaking.`,
      `• \`/voice <name>\` — Selects the bot's neural voice model.`,
      `• \`/say <text>\` — Interacts with the central Gemini orchestrator via text.`,
      `• \`/status <workflow_id>\` — Shows workflow stage, job status, and analysis results.`,
      `• \`/leave\` — Orders the bot to disconnect from the voice channel and reset context.`,
    ].join('\n'), true);
    return;
  }

  // Voice command
  if (commandName === 'voice') {
    const session = guildSessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: 'I am not in a voice channel. Run \`/join\` first!', ephemeral: true });
      return;
    }
    const voiceName = interaction.options.getString('name', true);
    session.ttsVoice = voiceName;
    
    try {
      await axios.patch(`${BACKEND_URL}/api/conversations/${session.activeConversationId}/voice`, {
        voice: voiceName
      });
    } catch (err) {
      console.error('[Discord Bot] Failed to sync voice to backend:', err);
    }
    
    await interaction.reply(`🎙️ **Bot voice model updated!** Active model set to: \`${voiceName}\``);
    return;
  }

  // TTS Toggle command
  if (commandName === 'tts') {
    const session = guildSessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: 'I am not in a voice channel. Run \`/join\` first!', ephemeral: true });
      return;
    }
    const enabled = interaction.options.getBoolean('enabled', true);
    session.ttsEnabled = enabled;
    await interaction.reply(enabled ? '🔊 **Voice playback enabled!** I will speak key updates back in the channel.' : '🔇 **Voice playback muted.** I will process everything silently in the background.');
    return;
  }

  // Start New Deal command
  if (commandName === 'new') {
    const session = guildSessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: 'I am not in a voice channel. Run \`/join\` first to start a session!', ephemeral: true });
      return;
    }
    const suffix = Math.random().toString(36).slice(2, 9);
    session.activeConversationId = `discord-${guildId}-${interaction.channelId}-${suffix}`;
    await interaction.reply(`🚀 **New Deal Workspace Activated!**\nAll subsequent voice discussions in this channel will feed into this fresh workspace: \`${session.activeConversationId}\``);
    return;
  }

  // Join Voice Channel command
  if (commandName === 'join') {
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const channel = member?.voice.channel;
    if (!channel) {
      await interaction.reply({ content: 'You need to join a voice channel first!', ephemeral: true });
      return;
    }

    if (!process.env.SPEECHMATICS_API_KEY) {
      await interaction.reply({ content: 'SPEECHMATICS_API_KEY not set. Voice transcription is disabled.', ephemeral: true });
      return;
    }

    // Acknowledge the interaction immediately to avoid 3-second timeout
    await interaction.deferReply();

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
          replyText += `\n> 📋 Job enqueued! Background analysis running...`;
          if (!session.pendingWorkflows) {
            session.pendingWorkflows = new Set();
          }
          session.pendingWorkflows.add(workflowId);
        }

        await sendLongMessage(session.activeTextChannel, replyText);
        console.log(`[Discord Bot] Posted agent response to channel.`);

        // Speak agent response in voice channel (Kokoro TTS)
        const spokenText = extractSpokenText(agentText);
        if (spokenText && session.connection && session.ttsEnabled) {
          speakInChannel(session.connection, spokenText, session.ttsVoice);
        }
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
      activeConversationId: `discord-${guildId}-${channel.id}`,
      activeTextChannel: interaction.channel as SendableChannel,
      activeUserStreams,
      userSpeakerMap,
      speakerCounter: 1,
      ttsEnabled: true,
      ttsVoice: process.env.TTS_VOICE || 'af_heart',
    });

    connection.on(VoiceConnectionStatus.Ready, async () => {
      console.log(`[Discord Bot] Joined voice channel ${channel.name}`);
      await interaction.editReply(`Joined voice channel **${channel.name}** and listening...`);

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
          end: { behavior: EndBehaviorType.AfterSilence, duration: 3000 },
        });

        const { opus } = require('prism-media');
        const pcmStream = opusStream.pipe(new opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }));

        pcmStream.on('data', (chunk: Buffer) => {
          // Downmix stereo int16 interleaved → mono
          const mono = Buffer.allocUnsafe(chunk.length / 2);
          for (let i = 0, j = 0; i < chunk.length; i += 4, j += 2) {
            if (i + 3 >= chunk.length) break;
            const l = chunk.readInt16LE(i);
            const r = chunk.readInt16LE(i + 2);
            mono.writeInt16LE((l + r) >> 1, j);
          }
          session.speechmatics.sendAudio(mono);
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

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.warn(`[Discord Bot] Voice connection disconnected for guild ${guildId}. Cleaning up.`);
      const session = guildSessions.get(guildId);
      if (session) {
        session.speechmatics.close();
        guildSessions.delete(guildId);
      }
    });
    return;
  }

  // Leave Voice Channel command (BUG J)
  if (commandName === 'leave') {
    const session = guildSessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: 'I am not in a voice channel in this server.', ephemeral: true });
      return;
    }

    // Proactively close the websocket connection first to send EndOfStream and flush in-flight packets,
    // wait 200ms to avoid cutting off buffered data, and then destroy the voice channel connection.
    session.speechmatics.close();
    setTimeout(() => {
      session.connection.destroy();
    }, 200);
    guildSessions.delete(guildId);

    await interaction.reply('Left voice channel and cleared active listening session.');
    return;
  }

  // Handle text interaction with agent
  if (commandName === 'say') {
    const text = interaction.options.getString('text');
    if (!text) return;

    await interaction.deferReply();

    try {
      const response = await axios.post(`${BACKEND_URL}/agent/invoke`, {
        conversationId: `discord-${guildId}-${interaction.channelId}`,
        text,
        speakerId: interaction.user.username,
        type: 'text'
      });
      const workflowId: string = response.data.workflowId;
      const enqueuedJobIds: string[] | undefined = response.data.enqueuedJobIds;
      
      let reply = response.data.response as string;
      const session = guildSessions.get(guildId);
      if (enqueuedJobIds && enqueuedJobIds.length > 0) {
        reply += `\n\n[System] Background analysis enqueued. I will post the completed scorecard here automatically!`;
        if (session) {
          if (!session.pendingWorkflows) {
            session.pendingWorkflows = new Set();
          }
          session.pendingWorkflows.add(workflowId);
        }
      }
      
      await sendLongMessage(interaction, reply, true);

      // Speak in voice channel if bot is currently in one for this guild
      if (session?.connection && session.ttsEnabled) {
        const spokenText = extractSpokenText(response.data.response as string);
        if (spokenText) {
          speakInChannel(session.connection, spokenText, session.ttsVoice);
        }
      }
    } catch (error) {
      console.error(error);
      await interaction.editReply('Error talking to the agent backend.');
    }
    return;
  }

  // Handle status checks - fetches real workflow/job data from backend
  if (commandName === 'status') {
    const workflowId = interaction.options.getString('workflow_id');
    
    if (!workflowId) {
      await interaction.reply({ content: 'You must provide a workflow ID.', ephemeral: true });
      return;
    }
    
    await interaction.deferReply();

    try {
      const response = await axios.get(`${BACKEND_URL}/agent/status/${workflowId}`);
      const { workflow, jobs } = response.data;
      
      const jobSummary = jobs.length > 0
        ? jobs.map((j: Job) => {
            let detail = `• **${j.type}**: \`${j.status}\``;
            if (j.status === 'COMPLETED' && j.result) {
              const res = j.result as {
                score?: string;
                recommendation?: string;
                summary?: string;
                pros?: string[];
                cons?: string[];
              };
              detail += ` [SUCCESS]\n  > **Investment Score:** \`${res.score}/10\` | **Recommendation:** \`${res.recommendation}\`\n  > **Executive Summary:** *${res.summary}*\n  > **Strengths:** ${res.pros?.join(', ') || 'None'}\n  > **Risks:** ${res.cons?.join(', ') || 'None'}`;
            } else if (j.status === 'FAILED' && j.error) {
              detail += ` [FAILED]\n  > **Error Details:** *${j.error}*`;
            }
            return detail;
          }).join('\n\n')
        : 'No background jobs enqueued.';
        
      const dealName = workflow.state?.dealName || 'Unknown Deal';
      const stageLabels: Record<string, string> = {
        'initial': 'Initial Discovery',
        'gathering': 'Information Gathering',
        'analysis_queued': 'Analysis Queued',
        'analysis_done': 'Analysis Completed',
        'decision': 'Investment Decision',
      };
      const label = stageLabels[workflow.state?.stage] || 'Active';

      const statusResponse = [
        `**ChorusOps Dealflow Analysis Pipeline — ${dealName}** (ID: \`${workflow.id.slice(0, 8)}\`)`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `● **Stage:** \`${label}\``,
        `● **Pipeline Status:** \`${workflow.status}\``,
        `● **Asynchronous Analytical Jobs:**\n${jobSummary}`,
      ].join('\n');

      await sendLongMessage(interaction, statusResponse, true);
    } catch (error) {
      await interaction.editReply('Could not fetch status. Make sure the workflow ID is correct.');
    }
  }
});

// Background polling loop to automatically notify Discord channel when a deep analysis job completes
setInterval(async () => {
  for (const [guildId, session] of guildSessions.entries()) {
    if (!session.pendingWorkflows || session.pendingWorkflows.size === 0) continue;

    for (const workflowId of Array.from(session.pendingWorkflows)) {
      try {
        const response = await axios.get(`${BACKEND_URL}/agent/status/${workflowId}`);
        const { workflow, jobs } = response.data;
        
        // Check if all jobs in this workflow are no longer PENDING or RUNNING
        const activeJobs = jobs.filter((j: any) => j.status === 'PENDING' || j.status === 'RUNNING');
        if (activeJobs.length === 0) {
          // All jobs completed or failed! Remove from pending list
          session.pendingWorkflows.delete(workflowId);

          const completedJob = jobs.find((j: any) => j.status === 'COMPLETED' && j.result);
          if (completedJob) {
            const res = completedJob.result as {
              score?: string;
              recommendation?: string;
              summary?: string;
              pros?: string[];
              cons?: string[];
            };

            const dealName = workflow.state?.dealName || 'Startup Deal';
            const scorecardMsg = `📢 **Deep Analysis Complete for ${dealName}!**\n` +
              `> **Investment Score:** \`${res.score}/10\` | **Recommendation:** \`${res.recommendation}\`\n` +
              `> **Executive Summary:** *${res.summary}*\n` +
              `> **Strengths:** ${res.pros?.join(', ') || 'None'}\n` +
              `> **Risks:** ${res.cons?.join(', ') || 'None'}`;

            await sendLongMessage(session.activeTextChannel, scorecardMsg);
            console.log(`[Discord Bot] Automatically posted async job result to Discord.`);

            // Speak the completed scorecard out loud in the channel hands-free!
            if (session.connection && session.ttsEnabled) {
              const speakText = `Deep analysis complete for ${dealName}. Score: ${res.score} out of 10. Recommendation: ${res.recommendation}. Summary: ${res.summary}`;
              speakInChannel(session.connection, speakText, session.ttsVoice);
            }
          } else {
            const failedJob = jobs.find((j: any) => j.status === 'FAILED');
            if (failedJob) {
              const errorMsg = `⚠️ **Deep Analysis Failed for ${workflow.state?.dealName || 'Startup Deal'}**\n> **Error Details:** *${failedJob.error || 'Unknown error during Featherless processing.'}*`;
              await sendLongMessage(session.activeTextChannel, errorMsg);
            }
          }
        }
      } catch (err) {
        console.error(`[Discord Bot] Error checking active workflow status for ${workflowId}:`, err);
      }
    }
  }
}, 3000);

client.login(process.env.DISCORD_BOT_TOKEN);
