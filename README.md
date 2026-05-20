# Technical guide to using Vertex AI in the DarijaGenie Chatbot Backend


## Executive Summary

DarijaGenie is a simple chatbot interface backed by a Node.js Express service. The backend does not call a raw model endpoint directly. Instead, it uses Google Cloud Vertex AI through the official `@google-cloud/vertexai` SDK to send prompts to Gemini.

The application pattern is straightforward:

1. The frontend maintains the conversation history and appends the newest user utterance.
2. The backend receives the complete updated `history` array through `POST /chat`.
3. The backend validates that history shape before making any model call.
4. The backend loads `prompt_5.txt` and sends it as the Gemini `systemInstruction`.
5. The backend serializes the full dialogue history into the user content sent to Vertex AI.
6. Gemini returns a text response containing an assistant reply and a JSON slot state.
7. The backend parses the response and returns `{ assistant, slots }` to the frontend.

This guide explains that implementation and why Vertex AI is a stronger production choice than plain direct LLM API calls when the application needs cloud-native authentication, IAM, service accounts, observability, quota management, centralized billing, and deployment integration.

## 1. Architecture Overview

The DarijaGenie backend is located in the `DarijaGenie` folder. It is a CommonJS Node.js service using:

- `express` for the HTTP API.
- `@google-cloud/vertexai` for Gemini access through Vertex AI.
- `prompt_5.txt` as the model behavior prompt.
- A Dockerfile based on Node 18 for container deployment.

The high-level request flow is:

```text
Frontend chat UI
  -> appends latest user utterance to dialogue history
  -> POST /chat { history }
  -> Express backend validates history
  -> backend loads prompt_5.txt
  -> backend calls Gemini through Vertex AI
  -> backend parses assistant text and slot JSON
  -> frontend receives { assistant, slots }
```

Vertex AI is the managed Google Cloud access layer for Gemini. DarijaGenie still owns the application logic around prompt loading, state packaging, validation, response parsing, and frontend-facing API design.

## 2. What Vertex AI Provides

Vertex AI is Google Cloud's managed AI platform. In this backend, its immediate purpose is to provide access to Gemini models, but the value is broader than a single HTTP endpoint.

For developers, Vertex AI provides:

- Programmatic access to Gemini through SDKs and REST APIs.
- Google Cloud authentication through Application Default Credentials and service accounts.
- Authorization through IAM.
- Project-level governance, quotas, and billing.
- Regional or global endpoint configuration depending on model and deployment needs.
- Integration with Cloud Logging, Cloud Monitoring, and broader Google Cloud operations.
- Options for scaling production workloads, including quota controls and throughput planning.

For a prototype, a direct API call may be faster to start. For a deployed service that multiple users will hit, Vertex AI is usually the better boundary because it fits into the rest of the Google Cloud deployment and security model.

## 3. Backend Setup

The project declares the Vertex AI SDK dependency in `package.json`:

```json
{
  "dependencies": {
    "@google-cloud/vertexai": "^1.10.0",
    "express": "^5.2.1"
  }
}
```

The backend imports and initializes Vertex AI in `server.js`:

```js
const { VertexAI } = require("@google-cloud/vertexai");

const LOCATION = process.env.VERTEX_LOCATION || "global";
const MODEL_NAME = process.env.VERTEX_MODEL || "gemini-3-flash-preview";
const API_ENDPOINT = process.env.VERTEX_API_ENDPOINT;
const PROJECT_ID =
  process.env.VERTEX_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.PROJECT_ID ||
  "YOUR_PROJECT_ID";

const vertexInit = {
  project: PROJECT_ID,
  location: LOCATION,
};

if (API_ENDPOINT) {
  vertexInit.apiEndpoint = API_ENDPOINT;
}

const vertexAI = new VertexAI(vertexInit);
const model = vertexAI.getGenerativeModel({
  model: MODEL_NAME,
});
```

The environment-driven design is important. It lets the same container run locally, in staging, and in production without changing source code.

### Runtime Configuration

The backend supports these environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port for Express | `8080` |
| `VERTEX_PROJECT_ID` | Google Cloud project used for Vertex AI | Falls back to `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `PROJECT_ID`, then `YOUR_PROJECT_ID` |
| `VERTEX_LOCATION` | Vertex AI location | `global` |
| `VERTEX_MODEL` | Gemini model name | `gemini-3-flash-preview` |
| `VERTEX_API_ENDPOINT` | Optional custom Vertex AI API endpoint | Not set |
| `CORS_ORIGIN` | Allowed browser origin | `*` |

For production, avoid leaving `CORS_ORIGIN=*` unless the service is intentionally public and protected elsewhere.

## 4. HTTP API Surface

The backend exposes two routes.

### `GET /health`

This returns a simple health response:

```json
{ "ok": true }
```

It is useful for local checks, Cloud Run health checks, uptime checks, and simple deployment verification.

### `POST /chat`

This is the main chatbot route. It expects:

```json
{
  "history": [
    {
      "assistant": {
        "utterance": "Initial assistant message",
        "slots": {}
      }
    },
    {
      "user": {
        "utterance": "User message"
      }
    }
  ]
}
```

The backend validates that:

- `history` is an array.
- Entries alternate between assistant and user.
- Assistant entries contain exactly one `assistant` key.
- Assistant entries contain `utterance` as a string and `slots` as an object.
- User entries contain exactly one `user` key.
- User entries contain `utterance` as a string.

This validation matters because malformed conversation state can produce poor model output, parsing failures, or unexpected slot updates.

## 5. The `/chat` Request Lifecycle

The central route performs five jobs.

First, it validates the input:

```js
const { history } = req.body || {};
const validationError = validateHistory(history);

if (validationError) {
  res.status(400).json({ error: validationError });
  return;
}
```

Second, it loads the system prompt:

```js
const promptText = await loadPromptText();
```

Third, it builds the Vertex AI request payload:

```js
const requestPayload = {
  systemInstruction: promptText,
  contents: [
    {
      role: "user",
      parts: [
        {
          text: `INPUT:\n${JSON.stringify(history)}\nEnd of input.`,
        },
      ],
    },
  ],
};
```

Fourth, it calls Gemini through Vertex AI:

```js
const result = await model.generateContent(requestPayload);
const rawReply = extractModelText(result ? result.response : undefined);
```

Fifth, it parses the model output and returns a frontend-friendly response:

```js
const { assistant, slots } = parseGeminiReply(rawReply);
res.json({ assistant, slots });
```

The backend intentionally hides Vertex AI response complexity from the frontend. The frontend only needs the assistant text and the updated slots.

## 6. `prompt_5.txt` as the System Instruction

The file `prompt_5.txt` defines DarijaGenie's behavior. It tells the model to act as a Moroccan restaurant server, reply in Moroccan Darija using Arabic script, follow a strict slot order, ask only one question per turn, and output two sections:

```text
ASSISTANT:
<darija reply in arabic script>

SLOT_STATE_JSON:
<valid JSON exactly, no trailing commas>
```

The backend sends this file as `systemInstruction`, which is the instruction layer used to steer Gemini's behavior. In practical terms:

- The prompt defines role, language, style, and output contract.
- The user content contains the current conversation state.
- The model combines both to produce the next assistant turn.

This separation is cleaner than embedding the full behavior prompt in every user message manually. The system instruction is the stable policy for the assistant. The user content is the variable input for the current request.

Google's Vertex AI Gemini API documentation describes `systemInstruction` as a way to steer model behavior, and the request body uses `contents` for single-turn or multi-turn input. DarijaGenie follows that same pattern, but packages the conversation as serialized JSON rather than using a native multi-message chat object.

## 7. The Prompt-Plus-History Pattern

HTTP requests are stateless. The backend does not inherently remember previous turns unless the application stores or sends them.

DarijaGenie handles this by sending the full current dialogue history on every `/chat` request:

```text
INPUT:
[{"assistant":{"utterance":"...","slots":{}}},{"user":{"utterance":"..."}}]
End of input.
```

The key idea is that the frontend appends the newest user utterance to the existing dialogue history, then sends the updated array. The backend serializes that array and forwards it to Gemini.

This gives the model the context it needs to:

- Know what has already been asked.
- Preserve previously collected slot values.
- Detect contradictions, such as a changed party size.
- Ask only for the earliest missing slot.
- Avoid restarting the conversation every turn.

The tradeoff is token growth. Every turn sends more text to the model. For short restaurant-order conversations, this is fine. For longer conversations, the backend should add token budgeting, summarization, or selective history truncation.

## 8. Structured Output and Slot State

DarijaGenie is not just free-form chat. It is a task-oriented chatbot that collects restaurant-order information.

The prompt requires JSON containing:

```json
{
  "slots": {
    "greeting": null,
    "party_size": null,
    "seating": null,
    "diet": null,
    "food_category": null,
    "dish": null,
    "portion": null,
    "drink": null,
    "special_requests": null,
    "confirmation": null,
    "closing": null
  },
  "action": "ask_slot"
}
```

This structured output is useful because the backend and frontend can treat the model response as application state, not only as text.

Structured state enables:

- Rendering order summaries.
- Deciding what slot is still missing.
- Resuming a conversation.
- Debugging model behavior.
- Logging state transitions.
- Testing expected dialogue flows.
- Integrating with future order-confirmation or restaurant systems.

The assistant utterance is for the user. The slot JSON is for the application.

## 9. Response Extraction and Defensive Parsing

LLMs do not always follow formatting instructions perfectly. DarijaGenie's backend accounts for common failure modes.

It extracts text from the Vertex AI response using either a direct `response.text()` helper or by walking response candidates and parts:

```js
function extractModelText(response) {
  if (!response) {
    return "";
  }

  if (typeof response.text === "function") {
    const directText = response.text();
    if (typeof directText === "string" && directText.trim()) {
      return directText;
    }
  }

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const textParts = [];

  for (const candidate of candidates) {
    const parts =
      candidate && candidate.content ? candidate.content.parts : undefined;
    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      if (part && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  }

  return textParts.join("\n").trim();
}
```

Then it normalizes common JSON-like output issues:

- Markdown fenced JSON blocks.
- Smart quotes.
- Python-style `None`, `True`, and `False`.
- Trailing commas.
- Single-quoted JSON-like keys and values.
- Extra text around a top-level JSON object.

This is pragmatic. The prompt asks for valid JSON, but production software should still protect itself against small model-output deviations.

That said, defensive parsing should not become a substitute for a real output contract. For production, add a strict schema validator and return a controlled error if the model output cannot be trusted.

## 10. Vertex AI vs Plain Direct API Calls

Plain direct API calls can be acceptable for small prototypes. A developer can send an HTTP request to a model endpoint, get a response, and build a demo quickly.

The problem is that production applications need more than "send prompt, receive text." They need a secure and observable operating model.

### Direct API Calls

Direct calls are simple, but developers often need to handle these concerns themselves:

- API key storage and rotation.
- Authentication model and credential leakage risks.
- Per-service access control.
- Request logging and tracing.
- Retry/backoff behavior.
- Quota and rate-limit handling.
- Cost attribution.
- Deployment-specific configuration.
- Environment separation across local, staging, and production.
- Monitoring dashboards and alerts.
- Team governance.

Direct API calls are not bad. They are just lower-level. They push more operational responsibility onto the application team.

### Vertex AI

Vertex AI gives the application a managed Google Cloud service layer around model access.

For DarijaGenie, that means:

- The backend uses Google Cloud project and location configuration instead of hard-coded model endpoint details.
- Authentication can use Application Default Credentials locally and service accounts in Google Cloud.
- IAM can restrict which service accounts or users can invoke Vertex AI.
- Usage is attached to a Google Cloud project for billing and governance.
- Quotas and throughput controls can be managed at the project and region level.
- Cloud Run, Cloud Logging, Cloud Monitoring, Secret Manager, and IAM fit naturally into the deployment architecture.
- Developers can use official SDKs instead of hand-rolling every HTTP detail.

Vertex AI does not remove the need for application engineering. DarijaGenie still has to validate requests, control CORS, manage prompt files, parse outputs, handle errors, and design its frontend contract. Vertex AI improves the model-access and cloud-operations layer.

## 11. Cloud Deployment Strategy for Heavy Usage

The included Dockerfile already makes DarijaGenie deployable as a container:

```dockerfile
FROM node:18

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
```

A natural Google Cloud deployment target is Cloud Run:

```bash
gcloud run deploy darijagenie \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/darijagenie:TAG \
  --region REGION \
  --service-account darijagenie-runtime@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars VERTEX_PROJECT_ID=PROJECT_ID,VERTEX_LOCATION=global,VERTEX_MODEL=gemini-3-flash-preview
```

This is illustrative. Replace region, project, repository, tag, and service account values with real deployment values.

### Service Accounts and IAM

In Cloud Run, the service identity is a service account attached to the running service. That service account is what the container uses when it calls Google Cloud APIs.

For DarijaGenie:

- Create a dedicated runtime service account.
- Grant it only the permissions needed to call Vertex AI.
- Avoid broad roles like Owner, Editor, or Viewer in production.
- Let the SDK use the service identity rather than embedding credential files in the container.

This is a major advantage over plain API-key-based integrations. Compromising an API key often grants whatever that key can do. With IAM, access can be limited to a specific service account and revoked centrally.

### Secret Manager

The current backend does not require a separate model API key when deployed properly on Google Cloud. It should authenticate through the Cloud Run service account.

If future versions add secrets, such as database credentials or private API tokens, store them in Secret Manager and expose them to Cloud Run as mounted files or environment variables. Do not bake secrets into the Docker image.

For environment variables that are not secrets, such as `VERTEX_MODEL`, `VERTEX_LOCATION`, or `CORS_ORIGIN`, use Cloud Run environment variable configuration.

### Autoscaling

Cloud Run can automatically scale the backend based on incoming requests and resource utilization. This helps absorb traffic spikes, but it does not mean the whole system has unlimited capacity.

For heavier use, configure:

- Maximum instances to control cost and protect downstream services.
- Minimum instances if cold starts hurt user experience.
- Request concurrency based on Node.js behavior and expected Vertex AI latency.
- Timeouts that reflect model-response latency.
- Load testing that includes realistic model call latency.

Autoscaling the Express container is only one layer. Vertex AI model capacity, quotas, network latency, and frontend behavior also affect throughput.

### Quotas and Throughput

Google Cloud quotas exist to manage shared capacity and cost. For generative AI on Vertex AI, the exact quota or throughput behavior depends on model, region, and current Google Cloud consumption options.

For `gemini-3-flash-preview`, verify current Vertex AI quota and throughput documentation before production launch. At the time this guide was generated, Google's documentation describes Dynamic Shared Quota for newer Gemini models and Provisioned Throughput as an option for predictable production capacity.

Production planning should include:

- Expected requests per minute.
- Average input tokens per request.
- Average output tokens per response.
- Peak traffic multiplier.
- Retry behavior during transient failures.
- Budget alerts.
- Capacity tests before public launch.

### Logging and Monitoring

Cloud Run automatically sends request logs and container logs to Cloud Logging. If DarijaGenie logs structured JSON to stdout or stderr, those logs can be queried in Logs Explorer.

Useful log fields include:

- Request ID.
- Conversation ID, if available.
- Vertex model name.
- Vertex location.
- Latency in milliseconds.
- Validation failures.
- Model-call failures.
- Response parse failures.
- Token estimates or token usage, if available.

Cloud Monitoring can track Cloud Run metrics such as request count, latency, error rates, instance count, and container resource usage. Vertex AI also exports metrics to Cloud Monitoring. Use dashboards and alerts for production operations.

Recommended alerts:

- High `5xx` rate on `/chat`.
- Increase in Vertex AI failures.
- High response latency.
- Parse failure rate above an acceptable threshold.
- Cloud Run instance saturation.
- Quota or rate-limit errors.
- Spending anomaly alerts through Google Cloud billing.

## 12. Reliability Best Practices

### Add Retry and Backoff

The current code calls `model.generateContent` once. Production systems should retry transient failures such as network timeouts, `429` responses, and temporary `5xx` errors.

Retries must be bounded. Do not blindly retry long model calls because that can multiply cost and worsen overload.

Recommended policy:

- Retry only transient errors.
- Use exponential backoff with jitter.
- Keep a small max retry count.
- Log final failure with request metadata.
- Return a useful frontend error message.

### Add Request IDs

Every request should get a stable request ID. Include it in:

- Application logs.
- Model-call logs.
- Error responses.
- Frontend diagnostics.

This makes a single failing user interaction traceable across the system.

### Validate Model Output with a Schema

The backend currently normalizes JSON-like output. That is useful, but production should also validate the final shape:

- Required slot keys.
- Allowed action values.
- `party_size` type.
- `confirmation` enum.
- No unexpected top-level fields if strictness matters.

Use a JSON schema validator such as Ajv if this service becomes production-facing.

### Use Token Budgeting

The prompt-plus-history pattern grows with each turn. Add a maximum history size or token budget.

Practical approaches:

- Keep only the latest N turns.
- Keep all slot state but summarize older natural-language turns.
- Store structured state separately from raw utterances.
- Use a short system prompt where possible.
- Set `maxOutputTokens` to prevent runaway responses.

## 13. Security Best Practices

### Do Not Expose `/chat` Without Protection

The current backend allows CORS from `*` by default. That is convenient locally, but risky for a public deployment.

For production:

- Set `CORS_ORIGIN` to the actual frontend origin.
- Put the backend behind authentication, an API gateway, Identity-Aware Proxy, Firebase Auth, or another access layer.
- Rate-limit requests per user or session.
- Add abuse detection for repeated expensive model calls.

### Prefer Service Account Authentication

On Google Cloud, the runtime should authenticate using a Cloud Run service account. Do not place service account JSON keys inside the repository or Docker image.

For local development, use Application Default Credentials:

```bash
gcloud auth application-default login
```

For production, grant the Cloud Run service account only the needed Vertex AI permissions.

### Keep Prompt Files Controlled

`prompt_5.txt` is part of the application behavior. Treat it like source code:

- Review prompt changes.
- Version prompt updates.
- Test prompt changes against known conversation cases.
- Avoid injecting untrusted text into the system prompt.
- Keep user input in the user content area, not in the instruction policy.



## 14. Suggested Improvements for DarijaGenie

The current backend is appropriate for a simple interface. Before heavier use, improve these areas:

1. Cache `prompt_5.txt` instead of reading it from disk on every request. Keep a development reload option if needed.
2. Add authentication or an API gateway before exposing `/chat` publicly.
3. Replace permissive CORS defaults with explicit origins.
4. Add request IDs and structured logging.
5. Add retry/backoff for transient Vertex AI failures.
6. Add token budgeting and history truncation or summarization.
7. Add strict JSON schema validation for model output.
8. Add latency, error-rate, token, and cost metrics.
9. Add load tests that include realistic model latency.
10. Add generation parameters for response length and predictability.
11. Consider streaming responses only if the UI needs partial output.
12. Verify whether the current SDK choice should remain `@google-cloud/vertexai` or be upgraded according to the latest Google Cloud SDK guidance.

## How to run

### Backend

``` 
gcloud --version
gcloud init
gcloud auth login
gcloud auth application-default login
gcloud config set project darijagenie
gcloud auth application-default set-quota-project darijagenie
gcloud services enable aiplatform.googleapis.com

cd DarijaGenie
nvm use 20

export VERTEX_PROJECT_ID=darijagenie
export VERTEX_LOCATION=global
export VERTEX_API_ENDPOINT=aiplatform.googleapis.com
export VERTEX_MODEL=gemini-3-flash-preview
npm start
```

### Frontend

```
cd ".."   # back to project root
nvm use 20
npm run dev
```
