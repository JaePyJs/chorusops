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
  state: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  id: string;
  workflowId: string;
  type: string;
  payload: any;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  result?: any;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// A single message turn stored for chat history persistence.
export interface ChatMessage {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

class InMemoryStore {
  public conversations: Map<string, Conversation> = new Map();
  public workflows: Map<string, Workflow> = new Map();
  public jobs: Map<string, Job> = new Map();
  // Stores serialized chat history per conversationId so sessions survive restarts.
  public chatHistories: Map<string, ChatMessage[]> = new Map();

  getChatHistory(conversationId: string): ChatMessage[] {
    return this.chatHistories.get(conversationId) ?? [];
  }

  appendChatMessage(conversationId: string, message: ChatMessage): void {
    const history = this.getChatHistory(conversationId);
    history.push(message);
    this.chatHistories.set(conversationId, history);
  }

  createConversation(id: string, participants: string[], channelId?: string): Conversation {
    const conv: Conversation = { id, participants, channelId, createdAt: new Date() };
    this.conversations.set(id, conv);
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
    return wf;
  }

  updateWorkflowState(id: string, stateDelta: Record<string, any>): Workflow | undefined {
    const wf = this.workflows.get(id);
    if (!wf) return undefined;
    wf.state = { ...wf.state, ...stateDelta };
    wf.updatedAt = new Date();
    return wf;
  }

  createJob(id: string, workflowId: string, type: string, payload: any): Job {
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
    return job;
  }

  updateJobStatus(id: string, status: Job['status'], result?: any, error?: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = status;
    if (result !== undefined) job.result = result;
    if (error !== undefined) job.error = error;
    job.updatedAt = new Date();
    return job;
  }
}

export const db = new InMemoryStore();
