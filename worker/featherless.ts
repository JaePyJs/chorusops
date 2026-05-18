import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.FEATHERLESS_API_KEY || 'sk-dummy',
  baseURL: process.env.FEATHERLESS_BASE_URL || 'https://api.featherless.ai/v1',
});

const MODEL = process.env.FEATHERLESS_MODEL || 'deepseek-ai/DeepSeek-V3.1';

export interface DeepAnalysisResult {
  summary: string;
  pros: string[];
  cons: string[];
  score: string;
  recommendation: string;
}

export interface DeepAnalysisPayload {
  dealName?: string;
  teamNotes?: string;
  marketNotes?: string;
  ask?: string;
  [key: string]: unknown;
}

export class FeatherlessClient {
  async runDeepAnalysis(payload: DeepAnalysisPayload): Promise<DeepAnalysisResult | { error: string; rawContent: string }> {
    const attempts = 3;
    let delay = 1000;

    for (let i = 0; i < attempts; i++) {
      try {
        console.log(`[Featherless] Starting DEEP_ANALYSIS (Attempt ${i + 1}/${attempts}) for:`, payload.dealName ?? 'unknown deal');

        const prompt = `
You are a senior investment analyst. Perform a deep analysis on the following startup pitch or deal context:
${JSON.stringify(payload, null, 2)}

Provide your output as structured JSON matching EXACTLY this schema, with no other text before or after:
{
  "summary": "Brief summary",
  "pros": ["pro1", "pro2"],
  "cons": ["con1", "con2"],
  "score": "1-10",
  "recommendation": "Pass or Invest"
}
`;

        const response = await client.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content ?? '{}';

        // Extract the first JSON object block from the response.
        // This handles models that output prose before/after the JSON.
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error(`Invalid response format: No JSON block found in content: ${content}`);
        }

        try {
          return JSON.parse(jsonMatch[0]) as DeepAnalysisResult;
        } catch {
          throw new Error(`Invalid JSON format: Failed to parse JSON block: ${jsonMatch[0]}`);
        }

      } catch (error) {
        console.error(`[Featherless] Attempt ${i + 1} failed:`, error);
        if (i === attempts - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error('Analysis failed after maximum retry attempts.');
  }
}

export const featherlessClient = new FeatherlessClient();
