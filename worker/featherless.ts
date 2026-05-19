import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config({ override: true });

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

IMPORTANT: Your ENTIRE response must be ONLY the raw JSON object. Do NOT include any explanation, preamble, markdown formatting, code fences, or text before or after the JSON. Start your response with { and end with }.
`;

        const response = await client.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content ?? '{}';

        // Bulletproof JSON extraction
        let cleaned = content.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '').trim();

        // 1. If it doesn't start with '{', forcefully locate the first known key
        if (!cleaned.startsWith('{')) {
          const firstKeyMatch = cleaned.match(/"(summary|pros|cons|score|recommendation)"\s*:/);
          if (firstKeyMatch && firstKeyMatch.index !== undefined) {
            cleaned = '{' + cleaned.slice(firstKeyMatch.index);
          } else {
            cleaned = '{' + cleaned;
          }
        }

        // 2. Find the final closing brace to slice off any trailing conversational text
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace !== -1) {
          cleaned = cleaned.slice(0, lastBrace + 1);
        } else {
          cleaned = cleaned + '}'; // Force append if entirely missing
        }

        try {
          const parsed = JSON.parse(cleaned);
          return {
            summary: String(parsed.summary ?? 'No summary provided.'),
            pros: Array.isArray(parsed.pros) ? parsed.pros.map(String) : [],
            cons: Array.isArray(parsed.cons) ? parsed.cons.map(String) : [],
            score: String(parsed.score ?? '5'),
            recommendation: String(parsed.recommendation ?? 'Pass'),
          } as DeepAnalysisResult;
        } catch (err: any) {
          console.warn(`[Featherless] JSON.parse failed. Engaging invincible Regex Fallback Parser...`);
          
          // Fallback: forcefully extract properties from the raw text using regex
          const summaryMatch = content.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
          const scoreMatch = content.match(/"score"\s*:\s*"(\d+)"/i);
          const recMatch = content.match(/"recommendation"\s*:\s*"([^"]+)"/i);
          
          const prosStr = content.match(/"pros"\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";
          const consStr = content.match(/"cons"\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";
          
          const pros = prosStr.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)?.map(s => s.replace(/(^"|"$)/g, '').replace(/\\"/g, '"')) || [];
          const cons = consStr.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)?.map(s => s.replace(/(^"|"$)/g, '').replace(/\\"/g, '"')) || [];

          if (!summaryMatch && pros.length === 0 && cons.length === 0) {
            throw new Error('Regex fallback also failed to extract any fields');
          }

          return {
            summary: summaryMatch ? summaryMatch[1].replace(/\\"/g, '"') : "No summary provided.",
            pros,
            cons,
            score: scoreMatch ? scoreMatch[1] : "5",
            recommendation: recMatch ? recMatch[1] : "Pass",
          } as DeepAnalysisResult;
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
