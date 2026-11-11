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
}

const body = (o: SupportOpts, stream: boolean) => {
  const b: Record<string, unknown> = { message: o.message };
  if (o.model && o.model !== "auto") b.model = o.model;
  if (o.prompt_version) b.prompt_version = o.prompt_version;
  if (o.include_reasoning) b.include_reasoning = true;
  b.stream = stream;
  return b;
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function supportSnippet(lang: Lang, base: string, o: SupportOpts) {
  const json = JSON.stringify(body(o, true), null, 2);
  if (lang === "curl") {
    return `# Streams Server-Sent Events: route, retrieval, intent, token…, done
curl -N ${base}/v1/support/answer \\
  -H "Authorization: Bearer $NALAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shq(JSON.stringify(body(o, true)))}`;
  }
  if (lang === "python") {
    return `import json, os
import requests  # pip install requests

resp = requests.post(
    "${base}/v1/support/answer",
    headers={"Authorization": f"Bearer {os.environ['NALAR_API_KEY']}"},
    json=${json.replace(/true/g, "True").replace(/false/g, "False")},
    stream=True,
    timeout=60,
)
resp.raise_for_status()  # 401 bad key · 403 missing scope · 429 quota (see Retry-After)

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
  return `// Node 18+ (built-in fetch)
const res = await fetch("${base}/v1/support/answer", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.NALAR_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${json.replace(/\n/g, "\n  ")}),
});
if (!res.ok) throw new Error((await res.json()).error.message); // 401 · 403 · 429 · 400

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

export function chatSnippet(lang: Lang, base: string) {
  if (lang === "curl") {
    return `# OpenAI-compatible: works with any OpenAI client by changing the base URL
curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer $NALAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Summarise our refund policy in one line."}],"stream":false}'`;
  }
  if (lang === "python") {
    return `import os
from openai import OpenAI  # pip install openai

client = OpenAI(base_url="${base}/v1", api_key=os.environ["NALAR_API_KEY"])
stream = client.chat.completions.create(
    model="auto",  # the router decides; or pin "fast" / "strong" / a backend id
    messages=[{"role": "user", "content": "Summarise our refund policy in one line."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`;
  }
  return `import OpenAI from "openai"; // npm i openai

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: process.env.NALAR_API_KEY });
const stream = await client.chat.completions.create({
  model: "auto", // the router decides; or pin "fast" / "strong" / a backend id
  messages: [{ role: "user", content: "Summarise our refund policy in one line." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`;
}

export const envSnippet = (secret?: string) =>
  `# keep it out of source control: a .env file (gitignored) or your secret manager
export NALAR_API_KEY=${secret ?? "nr_live_…"}`;
