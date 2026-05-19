const content = `  "summary": "Acme Robotics is a startup in the robotics space, but the provided deal context lacks critical details such as market size, technology differentiation, team background, revenue, and funding stage. Without this information, a thorough assessment is impossible.",
  "pros": ["Potential to operate in a high-growth robotics market if positioned correctly", "Robotics sector often attracts strong investor interest and talent"],
  "cons": ["No financial or operational data provided to evaluate viability", "Unknown competitive landscape and technology moat", "Lack of team credentials or traction increases risk"],
  "score": "3",
  "recommendation": "Pass"
}`;

let cleaned = content.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '').trim();

if (!cleaned.startsWith('{')) {
  const firstKeyMatch = cleaned.match(/"(summary|pros|cons|score|recommendation)"\s*:/);
  if (firstKeyMatch && firstKeyMatch.index !== undefined) {
    cleaned = '{' + cleaned.slice(firstKeyMatch.index);
  } else {
    cleaned = '{' + cleaned;
  }
}

const lastBrace = cleaned.lastIndexOf('}');
if (lastBrace !== -1) {
  cleaned = cleaned.slice(0, lastBrace + 1);
} else {
  cleaned = cleaned + '}';
}

console.log('Cleaned string length:', cleaned.length);
try {
  JSON.parse(cleaned);
  console.log('Parse successful!');
} catch (e) {
  console.log('Parse failed:', e.message);
}
