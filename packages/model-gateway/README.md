# @erdou/model-gateway

A thin BYO-key connector to chat LLM endpoints. Supports OpenAI-compatible (`/chat/completions`, Bearer auth) and Anthropic (`/v1/messages`, `x-api-key`) providers, with non-streaming and streaming (SSE) responses.

Config — base URL, API key, model — is passed in per call; **no secret is ever bundled or read from the environment**. Non-2xx responses fail loudly with the status and response body. This package is independent of the runtime layer and contains no agent logic.

```ts
import { ModelGateway } from "@erdou/model-gateway";

const gateway = new ModelGateway();
const { content } = await gateway.chat(
  { provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: KEY, model: "claude-sonnet-5" },
  [{ role: "user", content: "hello" }],
);
```
