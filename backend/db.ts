import fs from 'fs';
import path from 'path';

export interface Conversation {
  id: string;
  channelId?: string;
  participants: string[];
  createdAt: Date;
}

export interface Workflow {
  id: string;
  conversationId: string;
  type: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  id: string;
  workflowId: string;
  type: string;
  payload: unknown;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  result?: unknown;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

class InMemoryStore {
  public conversations: Map<string, Conversation> = new Map();
  public workflows: Map<string, Workflow> = new Map();
  public jobs: Map<string, Job> = new Map();
  public chatHistories: Map<string, ChatMessage[]> = new Map();

  private storePath = path.join(__dirname, '..', 'data', 'store.json');

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const dataStr = fs.readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(dataStr);
      
      if (parsed.conversations) {
        const list = parsed.conversations.map(([k, v]: [string, any]) => {
          v.createdAt = new Date(v.createdAt);
          return [k, v];
        });
        this.conversations = new Map(list);
      }
      if (parsed.workflows) {
        const list = parsed.workflows.map(([k, v]: [string, any]) => {
          v.createdAt = new Date(v.createdAt);
          v.updatedAt = new Date(v.updatedAt);
          return [k, v];
        });
        this.workflows = new Map(list);
      }
      if (parsed.jobs) {
        const list = parsed.jobs.map(([k, v]: [string, any]) => {
          v.createdAt = new Date(v.createdAt);
          v.updatedAt = new Date(v.updatedAt);
          return [k, v];
        });
        this.jobs = new Map(list);
      }
      if (parsed.chatHistories) {
        this.chatHistories = new Map(parsed.chatHistories);
      }
      console.log(`[Database] Loaded state successfully from disk (${this.storePath})`);
    } catch (e) {
      console.error('[Database] Failed to load state from disk:', e);
    }
  }

  private saveToDisk() {
    try {
      const dataDir = path.dirname(this.storePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const payload = {
        conversations: Array.from(this.conversations.entries()),
        workflows: Array.from(this.workflows.entries()),
        jobs: Array.from(this.jobs.entries()),
        chatHistories: Array.from(this.chatHistories.entries()),
      };
      fs.writeFileSync(this.storePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Database] Failed to save state to disk:', e);
    }
  }

  getChatHistory(conversationId: string): ChatMessage[] {
    return this.chatHistories.get(conversationId) ?? [];
  }

  appendChatMessage(conversationId: string, message: ChatMessage): void {
    const history = this.getChatHistory(conversationId);
    history.push(message);
    this.chatHistories.set(conversationId, history);
    this.saveToDisk();
  }

  createConversation(id: string, participants: string[], channelId?: string): Conversation {
    const conv: Conversation = { id, participants, channelId, createdAt: new Date() };
    this.conversations.set(id, conv);
    this.saveToDisk();
    return conv;
  }

  createWorkflow(id: string, conversationId: string, type: string): Workflow {
    const wf: Workflow = {
      id,
      conversationId,
      type,
      status: 'PENDING',
      state: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.workflows.set(id, wf);
    this.saveToDisk();
    return wf;
  }

  updateWorkflowState(id: string, stateDelta: Record<string, unknown>): Workflow | undefined {
    const wf = this.workflows.get(id);
    if (!wf) return undefined;
    wf.state = { ...wf.state, ...stateDelta };
    wf.updatedAt = new Date();
    this.saveToDisk();
    return wf;
  }

  updateWorkflowStatus(id: string, status: Workflow['status']): Workflow | undefined {
    const wf = this.workflows.get(id);
    if (!wf) return undefined;
    wf.status = status;
    wf.updatedAt = new Date();
    this.saveToDisk();
    return wf;
  }

  createJob(id: string, workflowId: string, type: string, payload: unknown): Job {
    const job: Job = {
      id,
      workflowId,
      type,
      payload,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.jobs.set(id, job);
    this.saveToDisk();
    return job;
  }

  updateJobStatus(id: string, status: Job['status'], result?: unknown, error?: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = status;
    if (result !== undefined) job.result = result;
    if (error !== undefined) job.error = error;
    job.updatedAt = new Date();
    this.saveToDisk();
    return job;
  }

  deleteConversation(id: string): boolean {
    const deleted = this.conversations.delete(id);
    this.chatHistories.delete(id);
    
    // Also delete any associated workflows and jobs to clean up the DB entirely
    const associatedWorkflows = Array.from(this.workflows.values()).filter(w => w.conversationId === id);
    for (const wf of associatedWorkflows) {
      this.workflows.delete(wf.id);
      // Delete jobs for this workflow
      const associatedJobs = Array.from(this.jobs.values()).filter(j => j.workflowId === wf.id);
      for (const j of associatedJobs) {
        this.jobs.delete(j.id);
      }
    }
    
    this.saveToDisk();
    return deleted;
  }
}

export const db = new InMemoryStore();
