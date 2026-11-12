/**
 * Code samples for calling the gateway with an API key. They read the key from the
 * NALAR_API_KEY environment variable on purpose: a key pasted into source code ends up in
 * git history, screenshots and logs.
 */
export type Lang = "curl" | "python" | "node";
export const LANGS: { id: Lang; label: string; language: string }[] = [
  { id: "curl", label: "cURL", language: "bash" },
  { id: "python", label: "Python", language: "python" },
  { id: "node", label: "Node.js", language: "javascript" },
];

export interface SupportOpts {
  message: string;
  model?: string;
  prompt_version?: string;
  include_reasoning?: boolean;
  stream?: boolean;
}

const supportBody = (o: SupportOpts) => {
  const b: Record<string, unknown> = { message: o.message };
  if (o.model && o.model !== "auto") b.model = o.model;
  if (o.prompt_version) b.prompt_version = o.prompt_version;
  if (o.include_reasoning) b.include_reasoning = true;
  b.stream = o.stream ?? true;
  return b;
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const pyJson = (json: string) => json.replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False");

export function supportSnippet(lang: Lang, base: string, o: SupportOpts) {
  const stream = o.stream ?? true;
  const b = supportBody(o);
  const json = JSON.stringify(b, null, 2);
  if (lang === "curl") {
    return `${stream ? "# Streams Server-Sent Events: route, retrieval, intent, token…, done" : "# One JSON body: answer, intent, confidence, retrieved entries, route, usage"}
curl ${stream ? "-N " : ""}${base}/v1/support/answer \\
  -H "Authorization: Bearer $NALAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shq(JSON.stringify(b))}`;
  }
  if (lang === "python") {
    const head = `import json, os
import requests  # pip install requests

resp = requests.post(
    "${base}/v1/support/answer",
    headers={"Authorization": f"Bearer {os.environ['NALAR_API_KEY']}"},
    json=${pyJson(json).replace(/\n/g, "\n    ")},${stream ? "\n    stream=True," : ""}
    timeout=60,
)
resp.raise_for_status()  # 401 bad key · 403 missing scope · 429 quota (see Retry-After)
`;
    if (!stream) {
      return `${head}
r = resp.json()
print(r["answer"])
print(f"\\n{r['intent']} ({r['confidence']}) via {r['backend']}, {r['usage']['totalTokens']} tokens")`;
    }
    return `${head}
event = None
for line in resp.iter_lines(decode_unicode=True):
    if line.startswith("event:"):
        event = line[6:].strip()
    elif line.startswith("data:"):
        data = json.loads(line[5:])
        if event == "token":
            print(data["text"], end="", flush=True)
        elif event == "done":
            print(f"\\n\\n{data['outcome']} via {data['backend']}, {data['usage']['totalTokens']} tokens")`;
  }
  const head = `// Node 18+ (built-in fetch)
const res = await fetch("${base}/v1/support/answer", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.NALAR_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${json.replace(/\n/g, "\n  ")}),
});
if (!res.ok) throw new Error((await res.json()).error.message); // 401 · 403 · 429 · 400
`;
  if (!stream) {
    return `${head}
const r = await res.json();
console.log(r.answer);
console.log(\`\\n\${r.intent} (\${r.confidence}) via \${r.backend}\`);`;
  }
  return `${head}
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n\\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
    if (event === "token") process.stdout.write(data.text);
    if (event === "done") console.log(\`\\n\\n\${data.outcome} via \${data.backend}\`);
  }
}`;
}

export interface ChatOpts {
  messages: { role: string; content: string }[];
  model?: string;
  include_reasoning?: boolean;
  stream?: boolean;
}
const DEFAULT_CHAT: ChatOpts = {
  messages: [{ role: "user", content: "Summarise our refund policy in one line." }],
  stream: false,
};

export function chatSnippet(lang: Lang, base: string, o: ChatOpts = DEFAULT_CHAT) {
  const stream = o.stream ?? true;
  const model = o.model && o.model !== "auto" ? o.model : "auto";
  const b: Record<string, unknown> = { model, messages: o.messages };
  if (o.include_reasoning) b.include_reasoning = true;
  b.stream = stream;
  const msgs = JSON.stringify(o.messages, null, 2);
  const modelComment = '# the router decides; or pin "fast" / "strong" / a backend id';
  if (lang === "curl") {
    return `# OpenAI-compatible: works with any OpenAI client by changing the base URL${stream ? "\n# Streams chat.completion.chunk events; routing and attempts arrive as SSE comments" : ""}
curl ${stream ? "-N " : ""}${base}/v1/chat/completions \\
  -H "Authorization: Bearer $NALAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shq(JSON.stringify(b))}`;
  }
  const extra = (py: boolean) =>
    o.include_reasoning
      ? py
        ? `\n    extra_body={"include_reasoning": True},`
        : `\n  include_reasoning: true, // gateway extension`
      : "";
  if (lang === "python") {
    const call = `import os
from openai import OpenAI  # pip install openai

client = OpenAI(base_url="${base}/v1", api_key=os.environ["NALAR_API_KEY"])
${stream ? "stream" : "resp"} = client.chat.completions.create(
    model="${model}",  ${modelComment}
    messages=${msgs.replace(/\n/g, "\n    ")},
    stream=${stream ? "True" : "False"},${extra(true)}
)`;
    return stream
      ? `${call}
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)`
      : `${call}
print(resp.choices[0].message.content)
print(resp.model_extra["x_router"])  # served-by backend, fallback, cost, latency`;
  }
  const call = `import OpenAI from "openai"; // npm i openai

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: process.env.NALAR_API_KEY });
const ${stream ? "stream" : "resp"} = await client.chat.completions.create({
  model: "${model}", // the router decides; or pin "fast" / "strong" / a backend id
  messages: ${msgs.replace(/\n/g, "\n  ")},
  stream: ${stream},${extra(false)}
});`;
  return stream
    ? `${call}
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`
    : `${call}
console.log(resp.choices[0].message.content);
console.log(resp.x_router); // served-by backend, fallback, cost, latency`;
}

export const envSnippet = (secret?: string) =>
  `# keep it out of source control: a .env file (gitignored) or your secret manager
export NALAR_API_KEY=${secret ?? "nr_live_…"}`;
