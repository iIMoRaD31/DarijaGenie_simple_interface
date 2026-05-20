import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Send } from "lucide-react";

interface Message {
  id: string;
  text: string;
  sender: "user" | "bot";
  timestamp: Date;
}

type SlotState = Record<string, unknown>;

type HistoryEntry =
  | {
      assistant: {
        utterance: string;
        slots: SlotState;
      };
    }
  | {
      user: {
        utterance: string;
      };
    };

const BACKEND_BASE_URL = (
  import.meta.env.VITE_BACKEND_URL ?? "https://YOUR_BACKEND_URL"
).replace(/\/+$/, "");
const CHAT_ENDPOINT = `${BACKEND_BASE_URL}/chat`;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const createMessage = (text: string, sender: "user" | "bot"): Message => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  text,
  sender,
  timestamp: new Date(),
});

export function Chat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const requestAssistantReply = useCallback(async (nextHistory: HistoryEntry[]) => {
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ history: nextHistory }),
    });

    const rawBody = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload: unknown = {};

    if (rawBody.trim() !== "") {
      const looksJson =
        contentType.includes("application/json") ||
        rawBody.trimStart().startsWith("{") ||
        rawBody.trimStart().startsWith("[");

      if (looksJson) {
        try {
          payload = JSON.parse(rawBody);
        } catch (error) {
          throw new Error("Backend returned invalid JSON.");
        }
      } else if (rawBody.trimStart().startsWith("<!DOCTYPE")) {
        throw new Error(
          "Backend URL returned HTML instead of JSON. Check VITE_BACKEND_URL and ensure /chat points to the API server.",
        );
      } else {
        throw new Error("Backend returned a non-JSON response.");
      }
    }

    if (!response.ok) {
      const message =
        isObjectRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "Backend request failed.";
      throw new Error(message);
    }

    if (!isObjectRecord(payload) || typeof payload.assistant !== "string") {
      throw new Error("Backend response is missing the assistant utterance.");
    }

    const slots =
      isObjectRecord(payload) && isObjectRecord(payload.slots)
        ? payload.slots
        : {};

    const assistantText = payload.assistant.trim();
    if (!assistantText) {
      throw new Error("Backend returned an empty assistant utterance.");
    }

    return {
      assistant: assistantText,
      slots,
    };
  }, []);

  const initializeConversation = useCallback(async () => {
    setIsLoading(true);

    try {
      const reply = await requestAssistantReply([]);
      const initialAssistantTurn: HistoryEntry = {
        assistant: {
          utterance: reply.assistant,
          slots: reply.slots,
        },
      };

      setHistory([initialAssistantTurn]);
      setMessages([createMessage(reply.assistant, "bot")]);
    } catch (error) {
      const fallback =
        error instanceof Error
          ? error.message
          : "Unable to start the conversation.";
      setHistory([]);
      setMessages([createMessage(fallback, "bot")]);
    } finally {
      setIsLoading(false);
    }
  }, [requestAssistantReply]);

  useEffect(() => {
    void initializeConversation();
  }, [initializeConversation]);

  const handleSendMessage = async () => {
    const userText = inputValue.trim();
    if (userText === "" || isLoading) return;

    if (history.length === 0) {
      await initializeConversation();
      return;
    }

    const userMessage = createMessage(userText, "user");
    const userTurn: HistoryEntry = {
      user: {
        utterance: userText,
      },
    };
    const nextHistory = [...history, userTurn];

    setMessages((prev) => [...prev, userMessage]);
    setHistory(nextHistory);
    setInputValue("");
    setIsLoading(true);

    try {
      const reply = await requestAssistantReply(nextHistory);
      const assistantTurn: HistoryEntry = {
        assistant: {
          utterance: reply.assistant,
          slots: reply.slots,
        },
      };

      setHistory((prev) => [...prev, assistantTurn]);
      setMessages((prev) => [...prev, createMessage(reply.assistant, "bot")]);
    } catch (error) {
      const fallback =
        error instanceof Error
          ? error.message
          : "Unable to retrieve assistant response.";
      // Keep strict alternation by rolling history back when assistant fails.
      setHistory(history);
      setMessages((prev) => [...prev, createMessage(fallback, "bot")]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleSendMessage();
    }
  };

  const handleEndConversation = () => {
    setMessages([]);
    setHistory([]);
    setInputValue("");
    navigate("/");
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50" dir="rtl">
      {/* Header */}
      <div className="bg-indigo-600 text-white p-4 shadow-md flex justify-between items-center">
        <h1 className="text-2xl font-bold">DarijaGenie</h1>
        <Button
          onClick={handleEndConversation}
          variant="secondary"
          size="sm"
        >
          End conversation
        </Button>
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-8">
            ابدأ المحادثة...
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.sender === "user" ? "justify-start" : "justify-end"
            }`}
          >
            <div
              className={`max-w-[70%] rounded-lg p-3 ${
                message.sender === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-gray-800 border border-gray-200"
              }`}
            >
              <p className="break-words">{message.text}</p>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 p-4">
        <div className="flex gap-2 items-center">
          <Button
            onClick={() => void handleSendMessage()}
            size="icon"
            className="bg-indigo-600 hover:bg-indigo-700"
            disabled={isLoading}
          >
            <Send className="h-4 w-4" />
          </Button>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="اكتب رسالتك هنا..."
            className="flex-1 text-right"
            dir="rtl"
            disabled={isLoading}
          />
        </div>
      </div>
    </div>
  );
}
