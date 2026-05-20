const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const { VertexAI } = require("@google-cloud/vertexai");

const PORT = Number(process.env.PORT) || 8080;
const LOCATION = process.env.VERTEX_LOCATION || "global";
const MODEL_NAME = process.env.VERTEX_MODEL || "gemini-2.5-flash";
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

if (PROJECT_ID === "YOUR_PROJECT_ID") {
  console.warn(
    "VERTEX_PROJECT_ID is not set. Set it in your environment before calling /chat.",
  );
}

const PROMPT_PATHS = [
  path.resolve(__dirname, "prompt_5.txt"),
  path.resolve(__dirname, "..", "prompt_5.txt"),
];

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateHistory(history) {
  if (!Array.isArray(history)) {
    return "history must be an array.";
  }

  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];

    if (!isPlainObject(entry)) {
      return `history[${index}] must be an object.`;
    }

    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      return `history[${index}] must contain exactly one key.`;
    }

    const expectsAssistant = index % 2 === 0;

    if (expectsAssistant) {
      if (keys[0] !== "assistant") {
        return `history[${index}] must be an assistant entry.`;
      }

      const assistant = entry.assistant;
      if (!isPlainObject(assistant)) {
        return `history[${index}].assistant must be an object.`;
      }

      if (typeof assistant.utterance !== "string") {
        return `history[${index}].assistant.utterance must be a string.`;
      }

      if (!isPlainObject(assistant.slots)) {
        return `history[${index}].assistant.slots must be an object.`;
      }
    } else {
      if (keys[0] !== "user") {
        return `history[${index}] must be a user entry.`;
      }

      const user = entry.user;
      if (!isPlainObject(user)) {
        return `history[${index}].user must be an object.`;
      }

      if (typeof user.utterance !== "string") {
        return `history[${index}].user.utterance must be a string.`;
      }
    }
  }

  return null;
}

async function loadPromptText() {
  for (const promptPath of PROMPT_PATHS) {
    try {
      return await fs.readFile(promptPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("prompt_5.txt not found.");
}

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

function sanitizeJsonBlock(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function sanitizeJsonLikeText(rawText) {
  return rawText
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/,\s*([}\]])/g, "$1");
}

function toLikelyJsonText(rawText) {
  const normalized = sanitizeJsonLikeText(rawText);
  // Last-resort conversion for JSON-like output using single quotes.
  return normalized
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
}

function parseJsonObject(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const attempts = [
    trimmed,
    sanitizeJsonLikeText(trimmed),
    toLikelyJsonText(trimmed),
  ];

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch (_error) {
      continue;
    }
  }

  return null;
}

function extractTopLevelJsonObjects(rawText) {
  const text = rawText || "";
  const objects = [];

  let inString = false;
  let escaped = false;
  let depth = 0;
  let startIndex = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        objects.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return objects;
}

function pickBestParsedObject(candidates) {
  const parsedCandidates = [];

  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate);
    if (parsed) {
      parsedCandidates.push(parsed);
    }
  }

  if (parsedCandidates.length === 0) {
    return null;
  }

  const withSlots = parsedCandidates.find((item) => isPlainObject(item.slots));
  return withSlots || parsedCandidates[0];
}

function normalizeSlotsObject(parsedSlotState) {
  if (!isPlainObject(parsedSlotState)) {
    return {};
  }

  if (isPlainObject(parsedSlotState.slots)) {
    return parsedSlotState.slots;
  }

  if (isPlainObject(parsedSlotState.slot_state)) {
    return parsedSlotState.slot_state;
  }

  if (isPlainObject(parsedSlotState.slotState)) {
    return parsedSlotState.slotState;
  }

  return parsedSlotState;
}

function parseSlotState(rawSlotState) {
  const cleaned = sanitizeJsonBlock(rawSlotState || "");
  if (!cleaned) {
    return {};
  }

  const fencedCandidates = [];
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let fencedMatch;
  while ((fencedMatch = fencedRegex.exec(cleaned)) !== null) {
    fencedCandidates.push(fencedMatch[1].trim());
  }

  const withoutLabel = cleaned
    .replace(/^\s*(?:SLOT_STATE_JSON|SLOT_STATE|SLOT_JSON)\s*:?\s*/i, "")
    .trim();

  const objectCandidates = [
    cleaned,
    withoutLabel,
    ...fencedCandidates,
    ...extractTopLevelJsonObjects(cleaned),
    ...extractTopLevelJsonObjects(withoutLabel),
  ];

  const parsed = pickBestParsedObject(objectCandidates);
  if (parsed) {
    return normalizeSlotsObject(parsed);
  }

  console.warn("Failed to parse SLOT_STATE_JSON. Using empty object.");
  return {};
}

function cleanAssistantBlock(rawAssistantText) {
  let cleaned = (rawAssistantText || "").trim();

  const fenced = cleaned.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    cleaned = fenced[1].trim();
  }

  cleaned = cleaned
    .replace(/^\s*(?:#+\s*)?\**\s*ASSISTANT\s*\**\s*:?\s*/i, "")
    .replace(/^\s*ASSISTANT\s*$/i, "")
    .trim();

  return cleaned;
}

function splitAssistantAndSlotBlocks(rawReply) {
  const markerRegex =
    /(?:^|\n|\r|\s)(SLOT_STATE_JSON|SLOT_STATE|SLOT_JSON)\s*:?\s*/i;
  const markerMatch = markerRegex.exec(rawReply);

  if (!markerMatch) {
    return {
      assistantBlock: rawReply,
      slotBlock: "",
    };
  }

  const slotMarkerStart = markerMatch.index + markerMatch[0].search(/\S/);
  const slotMarkerEnd = markerMatch.index + markerMatch[0].length;

  return {
    assistantBlock: rawReply.slice(0, slotMarkerStart).trim(),
    slotBlock: rawReply.slice(slotMarkerEnd).trim(),
  };
}

function parseStructuredReplyObject(rawReply) {
  const parsed = pickBestParsedObject([
    rawReply,
    ...extractTopLevelJsonObjects(rawReply),
  ]);

  if (!parsed) {
    return null;
  }

  const assistant =
    (typeof parsed.assistant === "string" && parsed.assistant) ||
    (typeof parsed.utterance === "string" && parsed.utterance) ||
    (typeof parsed.response === "string" && parsed.response) ||
    "";

  if (!assistant.trim()) {
    return null;
  }

  return {
    assistant: cleanAssistantBlock(assistant),
    slots: normalizeSlotsObject(parsed),
  };
}

function parseGeminiReply(rawReply) {
  const normalized = rawReply.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      assistant: "",
      slots: {},
    };
  }

  const structuredReply = parseStructuredReplyObject(normalized);
  if (structuredReply) {
    return structuredReply;
  }

  const { assistantBlock, slotBlock } = splitAssistantAndSlotBlocks(normalized);
  const assistant = cleanAssistantBlock(assistantBlock);

  return {
    assistant: assistant || cleanAssistantBlock(normalized),
    slots: parseSlotState(slotBlock),
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    const { history } = req.body || {};
    const validationError = validateHistory(history);

    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const promptText = await loadPromptText();
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

    const result = await model.generateContent(requestPayload);
    const rawReply = extractModelText(result ? result.response : undefined);

    if (!rawReply) {
      res.status(502).json({ error: "Gemini returned an empty response." });
      return;
    }

    const { assistant, slots } = parseGeminiReply(rawReply);

    if (!assistant) {
      res
        .status(502)
        .json({ error: "Gemini response missing assistant utterance." });
      return;
    }

    res.json({ assistant, slots });
  } catch (error) {
    console.error("Error while processing /chat:", {
      message: error instanceof Error ? error.message : error,
      model: MODEL_NAME,
      location: LOCATION,
      project: PROJECT_ID,
      apiEndpoint: API_ENDPOINT || `${LOCATION}-aiplatform.googleapis.com`,
      stack: error instanceof Error ? error.stack : undefined,
    });
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`DarijaGenie backend listening on port ${PORT}`);
});
