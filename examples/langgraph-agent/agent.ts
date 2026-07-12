/**
 * Minimal LangGraph agent that researches a page through web-data-mcp.
 *
 * Requires: OPENAI_API_KEY and APIFY_TOKEN in the environment, and a build
 * of the server in ../../dist (run `pnpm build` at the repo root first).
 *
 *   npm install && npm start -- "https://apify.com/pricing"
 */
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';

const targetUrl = process.argv[2] ?? 'https://apify.com/pricing';

const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    'web-data': {
      transport: 'stdio',
      command: 'node',
      args: ['../../dist/index.js'],
      env: { APIFY_TOKEN: process.env.APIFY_TOKEN ?? '' },
    },
  },
});

const tools = await mcpClient.getTools();

const agent = createAgent({
  model: new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 }),
  tools,
  prompt:
    'You are a web research agent. Use scrape_url to read pages. Check the quality block in ' +
    'every result: if the score is below 0.7, say so instead of trusting the content. ' +
    'Answer with cited facts only.',
});

const result = await agent.invoke({
  messages: [
    {
      role: 'user',
      content: `What does ${targetUrl} say? Summarize the key points in three bullets.`,
    },
  ],
});

const lastMessage = result.messages.at(-1);
console.log(String(lastMessage?.content));
await mcpClient.close();
