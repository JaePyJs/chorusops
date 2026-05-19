import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';

dotenv.config({ override: true });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

import { geminiClient } from './gemini';

// handle incoming transcript turns
app.post('/agent/invoke', async (req: Request, res: Response) => {
  try {
    const { conversationId, text, speakerId } = req.body;
    
    if (!conversationId || !text) {
      return res.status(400).json({ error: 'Missing conversationId or text' });
    }

    if (typeof conversationId !== 'string' || conversationId.length > 100 || !/^[a-zA-Z0-9\-_]+$/.test(conversationId)) {
      return res.status(400).json({ error: 'Invalid conversationId format' });
    }

    if (typeof text !== 'string' || text.length > 4000) {
      return res.status(400).json({ error: 'Input text is too long (maximum 4000 characters)' });
    }

    let conversation = db.conversations.get(conversationId);
    if (!conversation) {
      conversation = db.createConversation(conversationId, [speakerId || 'user'], conversationId);
      console.log(`[Backend] Created new conversation: ${conversationId}`);
    }

    const allWorkflows = Array.from(db.workflows.values())
      .filter(w => w.conversationId === conversationId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    let workflow = allWorkflows[0];
    
    if (!workflow) {
      workflow = db.createWorkflow(uuidv4(), conversationId, 'DEAL_EVALUATION');
      console.log(`[Backend] Created new workflow: ${workflow.id}`);
    }

    const jobIdsBefore = new Set(db.jobs.keys());

    console.log(`[Backend] Received input for ${conversationId} from ${speakerId || 'unknown'}: ${text}`);

    const inputWithContext = speakerId ? `[Speaker: ${speakerId}] ${text}` : text;
    const contextPrompt =
      `[System: conversationId=${conversationId}, activeWorkflowId=${workflow.id}]\n${inputWithContext}`;

    const agentResponse = await geminiClient.processInput(conversationId, contextPrompt, inputWithContext);

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

// get status of a workflow
app.get('/agent/status/:workflow_id', (req: Request, res: Response) => {
  const workflowId = req.params.workflow_id as string;
  const workflow = db.workflows.get(workflowId);

  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }

  const associatedJobs = Array.from(db.jobs.values()).filter(j => j.workflowId === workflowId);

  res.json({
    workflow,
    jobs: associatedJobs
  });
});

// fetch all conversations
app.get('/api/conversations', (req: Request, res: Response) => {
  const convs = Array.from(db.conversations.values())
    .map(c => {
      const history = db.getChatHistory(c.id);
      return { c, history };
    })
    .filter(({ history }) => history.length > 0)
    .map(({ c, history }) => {
      const firstMsg = history.find(m => m.role === 'user')?.parts[0]?.text || 'New Deal';
      const isDiscord = c.id.startsWith('discord-');
      const prefix = isDiscord ? '[Discord] ' : '';
      const title = prefix + firstMsg.slice(0, 35) + (firstMsg.length > 35 ? '...' : '');
      return { id: c.id, title, createdAt: c.createdAt };
    });
  res.json(convs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
});

// get details for a single conversation
app.get('/api/conversations/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const history = db.getChatHistory(id);
  const workflows = Array.from(db.workflows.values()).filter(w => w.conversationId === id);
  const latestWorkflow = workflows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  
  res.json({ history, workflowId: latestWorkflow?.id });
});

app.delete('/api/conversations/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const deleted = db.deleteConversation(id);
  res.json({ success: deleted });
});

import { startWorker } from '../worker/worker';

app.listen(port, () => {
  console.log(`[Backend] Server listening on port ${port}`);
  startWorker();
});
