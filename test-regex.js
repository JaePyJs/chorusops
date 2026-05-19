const content = `  "summary": "NovaPay is a seed-stage startup
seeking $2M. The pitch lacks details on business model, market, team, and traction, making it impossible to assess viability or risk.",
  "pros": ["Seed-stage allows early entry at potentially lower valuation", "Fintech sector has high growth potential if executed well"],
  "cons": ["No information on product, market size, or competitive advantage", "No team background or traction data to evaluate execution capability", "High risk typical of seed-stage investments without clear differentiation"],
  "score": "3",
  "recommendation": "Pass"
}`;

const summaryMatch = content.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
const scoreMatch = content.match(/"score"\s*:\s*"(\d+)"/i);
const recMatch = content.match(/"recommendation"\s*:\s*"([^"]+)"/i);

const prosStr = content.match(/"pros"\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";
const consStr = content.match(/"cons"\s*:\s*\[([\s\S]*?)\]/i)?.[1] || "";

const pros = prosStr.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)?.map(s => s.replace(/(^"|"$)/g, '').replace(/\\"/g, '"')) || [];
const cons = consStr.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)?.map(s => s.replace(/(^"|"$)/g, '').replace(/\\"/g, '"')) || [];

console.log('summaryMatch:', summaryMatch ? summaryMatch[1] : 'null');
console.log('pros:', pros);
console.log('cons:', cons);
console.log('scoreMatch:', scoreMatch ? scoreMatch[1] : 'null');
console.log('recMatch:', recMatch ? recMatch[1] : 'null');
