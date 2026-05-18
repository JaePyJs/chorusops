import { GoogleGenAI, Type, Schema } from '@google/genai';
import dotenv from 'dotenv';
import { db } from './db';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-2.5-flash'; // Or gemini-2.5-pro

// --- Define Tools ---

const updateStateTool = {
  name: 'update_state',
  description: 'Updates the current workflow state with new information. Use this to track progress, stages, or record key extracted details.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description: 'The ID of the workflow to update.',
      },
      stateDelta: {
        type: Type.STRING,
        description: 'A JSON string representing the key-value pairs to merge into the state.',
      },
    },
    required: ['workflowId', 'stateDelta'],
  },
};

const fetchStateTool = {
  name: 'fetch_state',
  description: 'Fetches the current state of a workflow.',
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
  description: 'Enqueues a heavy domain-specific task for the Featherless async worker. Use this when deep analysis, long-running data processing, or large-scale generation is needed.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description: 'The ID of the workflow this job belongs to.',
      },
      jobType: {
        type: Type.STRING,
        description: 'The type of job. Example: "DEEP_ANALYSIS"',
      },
      payload: {
        type: Type.STRING,
        description: 'A JSON string containing the data the worker needs to perform the job.',
      },
    },
    required: ['workflowId', 'jobType', 'payload'],
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

4. **Be state-aware.** Before responding, use fetch_state to check what you already know about the current deal. If analysis is already queued or completed, say so. Do not re-enqueue duplicate jobs.

5. **Handle failures gracefully.** If a tool call fails, acknowledge it and try an alternative or ask the user for clarification.

## Workflow State Schema
When updating state, always use these keys where applicable:
- dealName: string
- stage: "initial" | "gathering" | "analysis_queued" | "analysis_done" | "decision"
- teamNotes: string
- marketNotes: string
- ask: string (funding ask)
- questions: string[]
- jobId: string (set when analysis is enqueued)
- recommendation: string (set after analysis)

## Output Style
Keep replies concise and natural — your response may be read aloud in a voice channel. Use short sentences. Avoid markdown. If a job is queued, say so clearly and tell the user how to check back.
`;

export class GeminiClient {
  private chatSessions: Map<string, any> = new Map();

  async processInput(conversationId: string, userInput: string): Promise<string> {
    try {
      let chat = this.chatSessions.get(conversationId);
      
      if (!chat) {
        chat = ai.chats.create({
          model: MODEL_NAME,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: tools,
            temperature: 0.2,
          }
        });
        this.chatSessions.set(conversationId, chat);
      }

      // Send the message to Gemini
      let response = await chat.sendMessage({ text: userInput });

      // Handle function calls
      while (response.functionCalls && response.functionCalls.length > 0) {
        const functionResponses: any[] = [];

        for (const call of response.functionCalls) {
          console.log(`[Gemini] Tool call: ${call.name} with args:`, call.args);
          let result: any;

          try {
            if (call.name === 'update_state') {
              const parsedDelta = JSON.parse(call.args.stateDelta as string);
              const wf = db.updateWorkflowState(call.args.workflowId as string, parsedDelta);
              result = { success: true, newState: wf?.state || {} };
            } 
            else if (call.name === 'fetch_state') {
              const wf = db.workflows.get(call.args.workflowId as string);
              result = { success: true, state: wf?.state || {} };
            } 
            else if (call.name === 'enqueue_featherless_job') {
              const parsedPayload = JSON.parse(call.args.payload as string);
              const jobId = uuidv4();
              const job = db.createJob(
                jobId, 
                call.args.workflowId as string, 
                call.args.jobType as string, 
                parsedPayload
              );
              console.log(`[Gemini] Enqueued job: ${jobId}`);
              result = { success: true, jobId, status: 'PENDING' };
            }
          } catch (e: any) {
             console.error(`[Gemini] Tool execution error for ${call.name}:`, e.message);
             result = { success: false, error: e.message };
          }

          functionResponses.push({
            name: call.name,
            response: result
          });
        }

        // Send tool execution results back to Gemini
        console.log(`[Gemini] Sending tool responses back...`);
        response = await chat.sendMessage(functionResponses);
      }

      // Return the final text response
      return response.text || "I processed that, but have no text response.";

    } catch (error) {
      console.error('[Gemini] Error processing input:', error);
      return "I encountered an error while processing your request.";
    }
  }
}

export const geminiClient = new GeminiClient();
