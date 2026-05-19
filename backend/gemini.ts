import { GoogleGenAI, Type } from '@google/genai';
import type { Chat, GenerateContentResponse, Part } from '@google/genai';
import dotenv from 'dotenv';
import { db } from './db';
import { v4 as uuidv4 } from 'uuid';

dotenv.config({ override: true });

const useVertex = process.env.USE_VERTEX === 'true';
let ai: GoogleGenAI;

if (useVertex) {
  const projectId = process.env.GCP_PROJECT_ID || 'project-2aa9d51d-e1b8-459f-a44';
  const location = process.env.GCP_LOCATION || 'us-central1';
  console.log(`[Gemini] Initializing GoogleGenAI in Vertex AI Mode (Project: ${projectId}, Location: ${location})`);
  ai = new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location: location,
  });
} else {
  const keyToUse = process.env.GEMINI_API_KEY;
  if (!keyToUse) {
    throw new Error('[Gemini] GEMINI_API_KEY environment variable is not defined!');
  }
  console.log(`[Gemini] Initializing GoogleGenAI in AI Studio Mode with API Key: ${keyToUse.slice(0, 8)}...${keyToUse.slice(-4)} (length: ${keyToUse.length})`);
  ai = new GoogleGenAI({
    apiKey: keyToUse,
  });
}

const MODEL_NAME = 'gemini-2.5-flash';

// --- Define Tools ---

const updateStateTool = {
  name: 'update_state',
  description: 'Updates the current workflow state with new information. Use this to track progress, deal stages, or record key extracted details. Call this proactively after every user turn that introduces new deal information.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description: 'The ID of the workflow to update. Use the active workflowId from the system context.',
      },
      dealName: { type: Type.STRING, description: 'Name of the startup or deal.' },
      stage: {
        type: Type.STRING,
        description: 'Current stage: "initial", "gathering", "analysis_queued", "analysis_done", or "decision".',
      },
      teamNotes: { type: Type.STRING, description: 'Notes about the founding team.' },
      marketNotes: { type: Type.STRING, description: 'Notes about the market opportunity.' },
      ask: { type: Type.STRING, description: 'Funding ask (e.g. "$2M seed").' },
      questions: {
        type: Type.ARRAY,
        description: 'Open questions that need answers.',
        items: { type: Type.STRING },
      },
      jobId: { type: Type.STRING, description: 'Set to the job ID after enqueuing a Featherless job.' },
      recommendation: { type: Type.STRING, description: 'Final recommendation after analysis: "Pass", "Invest", or "More Info".' },
    },
    required: ['workflowId'],
  },
};

const fetchStateTool = {
  name: 'fetch_state',
  description: 'Fetches the current workflow state. Call this before responding to ensure you are not duplicating work (e.g. re-enqueuing an already queued job).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description: 'The ID of the workflow to fetch.',
      },
    },
    required: ['workflowId'],
  },
};

const enqueueFeatherlessJobTool = {
  name: 'enqueue_featherless_job',
  description: 'Enqueues a DEEP_ANALYSIS job for the Featherless async worker. Use ONLY when the user asks for deep analysis, due diligence, competitive landscape, or financial sanity check. Do NOT answer these yourself. The job will run in the background.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description: 'The ID of the workflow this job belongs to.',
      },
      jobType: {
        type: Type.STRING,
        description: 'Job type. Use "DEEP_ANALYSIS" for deal analysis.',
      },
      dealName: { type: Type.STRING, description: 'Name of the deal to analyze.' },
      teamNotes: { type: Type.STRING, description: 'Team context from workflow state.' },
      marketNotes: { type: Type.STRING, description: 'Market context from workflow state.' },
      ask: { type: Type.STRING, description: 'Funding ask from workflow state.' },
    },
    required: ['workflowId', 'jobType', 'dealName'],
  },
};

const tools = [{
  functionDeclarations: [updateStateTool, fetchStateTool, enqueueFeatherlessJobTool]
}];

const SYSTEM_PROMPT = `
You are an expert Dealflow Orchestrator Agent embedded in a Discord voice channel. Your role is to listen to discussions about startup pitches and investment deals, maintain a structured deal pipeline, and coordinate deep domain analysis.

You are a PLANNER, not a Q&A bot. You must think in multi-step workflows, maintain persistent state across turns, and decide when to act vs. when to gather more information.

## Your Core Responsibilities

1. **Maintain a structured deal pipeline.** For every startup or opportunity discussed, track its state using update_state. Record: deal name, stage, key metrics mentioned, questions raised, and current workflow status. Always keep state up to date after each user message.

2. **Plan multi-step workflows.** When a deal is introduced, your plan is:
   - Step 1: Gather info (company, market, team, ask). Update state as facts emerge.
   - Step 2: When sufficient context is present, enqueue a DEEP_ANALYSIS job via Featherless.
   - Step 3: After analysis is complete (check state), surface key insights and suggest next actions (e.g., "contact legal", "request pitch deck", "pass — market too small").

3. **Decide when NOT to answer immediately.** If the user asks for deep market analysis, competitive landscape, financial sanity check, or due diligence — DO NOT attempt to answer with your own reasoning. Instead, use enqueue_featherless_job to dispatch the task to the specialized worker, then tell the user the job is queued.

4. **Be state-aware.** Only call fetch_state when you are about to enqueue a job and need to verify no duplicate job exists. Do NOT call fetch_state on every turn — only before enqueue_featherless_job. If analysis is already queued or completed, say so. Do not re-enqueue duplicate jobs.

5. **Handle failures gracefully.** If a tool call fails, acknowledge it and try an alternative or ask the user for clarification.

## Active Context
The system will inject the active conversationId and workflowId at the start of each message in the format:
[System: conversationId=<id>, activeWorkflowId=<id>]

Always use the injected activeWorkflowId when calling tools. Never make up a workflow ID.

## Output Style
Keep replies concise and natural — your response may be read aloud in a voice channel. Use short sentences. Avoid markdown in spoken responses. When a job is enqueued, ALWAYS include the workflowId in your reply so the user can run !status <workflowId>.
`;

export class GeminiClient {
  private chatSessions: Map<string, Chat> = new Map();

  async processInput(conversationId: string, userInput: string, cleanInput?: string): Promise<string> {
    try {
      let chat = this.chatSessions.get(conversationId);

      if (!chat) {
        const existingHistory = db.getChatHistory(conversationId);

        chat = ai.chats.create({
          model: MODEL_NAME,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: tools,
            temperature: 0.2,
          },
          history: existingHistory,
        });
        this.chatSessions.set(conversationId, chat);
      }

      db.appendChatMessage(conversationId, { role: 'user', parts: [{ text: cleanInput || userInput }] });

      let response = await chat.sendMessage({ message: userInput });

      let loopCount = 0;
      const MAX_TOOL_LOOPS = 10;
      while (response.functionCalls && response.functionCalls.length > 0) {
        if (loopCount++ >= MAX_TOOL_LOOPS) {
          console.warn(`[Gemini] Warning: Exceeded max tool planning loops of ${MAX_TOOL_LOOPS}. Terminating turn.`);
          return 'Agent exceeded planning steps. Please try again.';
        }
        const functionResponses: Part[] = [];

        for (const call of response.functionCalls) {
          console.log(`[Gemini] Tool call: ${call.name}`, call.args);
          let result: Record<string, unknown>;

          try {
            if (call.name === 'update_state') {
              const { workflowId, ...stateDelta } = call.args as { workflowId: string; [key: string]: unknown };
              const cleanDelta = Object.fromEntries(
                Object.entries(stateDelta).filter(([, v]) => v !== undefined)
              );
              const wf = db.updateWorkflowState(workflowId, cleanDelta);
              result = { success: true, newState: wf?.state ?? {} };
            }
            else if (call.name === 'fetch_state') {
              const { workflowId } = call.args as { workflowId: string };
              const wf = db.workflows.get(workflowId);
              result = { success: true, state: wf?.state ?? {}, workflowStatus: wf?.status ?? 'NOT_FOUND' };
            }
            else if (call.name === 'enqueue_featherless_job') {
              const { workflowId, jobType, ...payloadFields } = call.args as {
                workflowId: string; jobType: string; [key: string]: unknown;
              };
              const jobId = uuidv4();
              db.createJob(jobId, workflowId, jobType, payloadFields);
              db.updateWorkflowState(workflowId, { jobId, stage: 'analysis_queued' });
              console.log(`[Gemini] Enqueued job ${jobId} (${jobType}) on workflow ${workflowId}`);
              result = { success: true, jobId, workflowId, status: 'PENDING' };
            }
            else {
              result = { success: false, error: `Unknown tool: ${call.name}` };
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[Gemini] Tool error (${call.name}):`, msg);
            result = { success: false, error: msg };
          }

          functionResponses.push({
            functionResponse: {
              name: call.name ?? 'unknown',
              id: call.id,
              response: result,
            },
          });
        }

        console.log(`[Gemini] Returning ${functionResponses.length} tool result(s) to model...`);
        response = await chat.sendMessage({ message: functionResponses });
      }

      const finalText = (response.text != null && response.text !== '') 
        ? response.text 
        : 'I processed that, but have no text response.';

      db.appendChatMessage(conversationId, { role: 'model', parts: [{ text: finalText }] });

      return finalText;

    } catch (error) {
      console.error('[Gemini] Error processing input:', error);
      return 'I encountered an error while processing your request. Please try again.';
    }
  }
}

export const geminiClient = new GeminiClient();
