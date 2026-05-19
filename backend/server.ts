import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Health Check ---
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

import { geminiClient } from './gemini';

// --- Agent Invoke ---
// Main entrypoint for bot transcripts or messages.
app.post('/agent/invoke', async (req: Request, res: Response) => {
  try {
    const { conversationId, text, speakerId } = req.body;
    
    if (!conversationId || !text) {
      return res.status(400).json({ error: 'Missing conversationId or text' });
    }

    // Robust validation for conversationId to prevent junk format attacks
    if (typeof conversationId !== 'string' || conversationId.length > 100 || !/^[a-zA-Z0-9\-_]+$/.test(conversationId)) {
      return res.status(400).json({ error: 'Invalid conversationId format' });
    }

    // Input length limit of 4000 characters to protect against token exhaustion
    if (typeof text !== 'string' || text.length > 4000) {
      return res.status(400).json({ error: 'Input text is too long (maximum 4000 characters)' });
    }

    let conversation = db.conversations.get(conversationId);
    if (!conversation) {
      // Create a default conversation if none exists
      conversation = db.createConversation(conversationId, [speakerId || 'user']);
      console.log(`[Backend] Created new conversation: ${conversationId}`);
    }

    // Default workflow id to conversation id for simplicity in this hackathon
    let workflow = Array.from(db.workflows.values()).find(w => w.conversationId === conversationId && w.status !== 'COMPLETED');
    if (!workflow) {
      workflow = db.createWorkflow(uuidv4(), conversationId, 'DEAL_EVALUATION');
      console.log(`[Backend] Created new workflow: ${workflow.id}`);
    }

    // Snapshot existing job IDs before Gemini call.
    // Diffing against this set after the call gives us exactly the new jobs — no slice bugs.
    const jobIdsBefore = new Set(db.jobs.keys());

    console.log(`[Backend] Received input for ${conversationId} from ${speakerId || 'unknown'}: ${text}`);

    // Inject conversationId + activeWorkflowId in the format the system prompt expects.
    // Gemini never needs to guess or hallucinate IDs — they are always explicit in context.
    const inputWithContext = speakerId ? `[Speaker: ${speakerId}] ${text}` : text;
    const contextPrompt =
      `[System: conversationId=${conversationId}, activeWorkflowId=${workflow.id}]\n${inputWithContext}`;

    const agentResponse = await geminiClient.processInput(conversationId, contextPrompt, inputWithContext);

    // Detect exactly which new jobs were enqueued during this Gemini turn
    const newJobIds = Array.from(db.jobs.keys()).filter(id => !jobIdsBefore.has(id));

    res.json({
      success: true,
      response: agentResponse,
      conversationId: conversation.id,
      workflowId: workflow.id,
      enqueuedJobIds: newJobIds.length > 0 ? newJobIds : undefined,
    });

  } catch (error) {
    console.error('[Backend] Error in /agent/invoke:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Status Endpoint ---
// Checks the status of a specific workflow and its jobs
app.get('/agent/status/:workflow_id', (req: Request, res: Response) => {
  const workflowId = req.params.workflow_id as string;
  const workflow = db.workflows.get(workflowId);

  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }

  // Find all jobs associated with this workflow
  const associatedJobs = Array.from(db.jobs.values()).filter(j => j.workflowId === workflowId);

  res.json({
    workflow,
    jobs: associatedJobs
  });
});

// --- History Endpoints for GPT-Style UI ---
app.get('/api/conversations', (req: Request, res: Response) => {
  const convs = Array.from(db.conversations.values())
    .map(c => {
      const history = db.getChatHistory(c.id);
      return { c, history };
    })
    .filter(({ history }) => history.length > 0) // Only display deals with actual conversation history
    .map(({ c, history }) => {
      const firstMsg = history.find(m => m.role === 'user')?.parts[0]?.text || 'New Deal';
      const title = firstMsg.slice(0, 35) + (firstMsg.length > 35 ? '...' : '');
      return { id: c.id, title, createdAt: c.createdAt };
    });
  res.json(convs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
});

app.get('/api/conversations/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const history = db.getChatHistory(id);
  // Find the most recent workflow for this conversation
  const workflows = Array.from(db.workflows.values()).filter(w => w.conversationId === id);
  const latestWorkflow = workflows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  
  res.json({ history, workflowId: latestWorkflow?.id });
});

import { startWorker } from '../worker/worker';

// --- Start Server and Worker ---
app.listen(port, () => {
  console.log(`[Backend] Server listening on port ${port}`);
  startWorker();
});
