import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.FEATHERLESS_API_KEY || 'sk-dummy',
  baseURL: process.env.FEATHERLESS_BASE_URL || 'https://api.featherless.ai/v1',
});

const MODEL = process.env.FEATHERLESS_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';

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

        // Robust JSON block extraction (supporting standard JSON and unbraced plain key-value structures)
        let jsonStr = '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        } else {
          // Strip any markdown code block wrapper boundaries (e.g. ```json ... ```)
          let cleaned = content.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '').trim();
          if (!cleaned.startsWith('{')) {
            cleaned = `{${cleaned}}`;
          }
          jsonStr = cleaned;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          return {
            summary: String(parsed.summary ?? 'No summary provided.'),
            pros: Array.isArray(parsed.pros) ? parsed.pros.map(String) : [],
            cons: Array.isArray(parsed.cons) ? parsed.cons.map(String) : [],
            score: String(parsed.score ?? '5'),
            recommendation: String(parsed.recommendation ?? 'Pass'),
          } as DeepAnalysisResult;
        } catch (err: any) {
          throw new Error(`Failed to parse response: ${err.message}. Original content: ${content}`);
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
