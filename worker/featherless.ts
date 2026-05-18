import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.FEATHERLESS_API_KEY || 'sk-dummy',
  baseURL: process.env.FEATHERLESS_BASE_URL || 'https://api.featherless.ai/v1',
});

const MODEL = process.env.FEATHERLESS_MODEL || 'meta-llama/Meta-Llama-3-70B-Instruct';

export class FeatherlessClient {
  async runDeepAnalysis(payload: any): Promise<any> {
    try {
      console.log(`[Featherless] Starting DEEP_ANALYSIS for payload:`, payload);
      
      const prompt = `
You are a senior investment analyst. Perform a deep analysis on the following startup pitch or deal context:
${JSON.stringify(payload, null, 2)}

Provide your output as structured JSON matching this schema:
{
  "summary": "Brief summary",
  "pros": ["pro1", "pro2"],
  "cons": ["con1", "con2"],
  "score": "1-10",
  "recommendation": "Pass or Invest"
}
Output ONLY valid JSON.
`;

      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const content = response.choices[0].message.content || '{}';
      
      try {
        // Strip out potential markdown formatting
        const cleanedContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedContent);
      } catch (parseError) {
        console.error('[Featherless] Failed to parse JSON response:', content);
        return { error: 'Failed to parse JSON', rawContent: content };
      }

    } catch (error) {
      console.error('[Featherless] Error during analysis:', error);
      throw error;
    }
  }
}

export const featherlessClient = new FeatherlessClient();
