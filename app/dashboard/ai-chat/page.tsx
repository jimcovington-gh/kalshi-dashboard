'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { 
  sendAIChatMessageStreaming, 
  ChatMessage,
  AIChatStreamDone,
  ToolCall,
  listConversations,
  saveConversation,
  loadConversation,
  deleteConversation,
  SavedConversation
} from '@/lib/api';
import ReactMarkdown from 'react-markdown';

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isLoading?: boolean;
  progress?: string;
  toolCalls?: ToolCall[];
}

// Generate a unique conversation ID
function generateConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Local storage key for current conversation
const CURRENT_CONVERSATION_KEY = 'ai-chat-current-conversation';
const CONVERSATION_ID_KEY = 'ai-chat-conversation-id';

export default function AIChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [conversationId, setConversationId] = useState<string>('');
  const [savedConversations, setSavedConversations] = useState<SavedConversation[]>([]);
  const [showSavedPanel, setShowSavedPanel] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load conversation from localStorage on mount
  useEffect(() => {
    const savedMessages = localStorage.getItem(CURRENT_CONVERSATION_KEY);
    const savedId = localStorage.getItem(CONVERSATION_ID_KEY);
    
    if (savedMessages) {
      try {
        const parsed = JSON.parse(savedMessages);
        setMessages(parsed.map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp),
        })));
      } catch (e) {
        console.error('Failed to parse saved conversation:', e);
      }
    }
    
    setConversationId(savedId || generateConversationId());
  }, []);

  // Save conversation to localStorage when messages change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(CURRENT_CONVERSATION_KEY, JSON.stringify(messages));
      localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
    }
  }, [messages, conversationId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, progress]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load saved conversations list
  const loadSavedConversations = useCallback(async () => {
    const conversations = await listConversations();
    setSavedConversations(conversations);
  }, []);

  useEffect(() => {
    loadSavedConversations();
  }, [loadSavedConversations]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setError(null);
    setProgress('');

    // Add user message to display
    const newUserMessage: DisplayMessage = {
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, newUserMessage]);

    // Add loading placeholder for assistant
    const loadingMessage: DisplayMessage = {
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isLoading: true,
    };
    setMessages(prev => [...prev, loadingMessage]);
    setIsLoading(true);

    // Build conversation history for API
    const apiMessages: ChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    apiMessages.push({ role: 'user', content: userMessage });

    // Send streaming request
    await sendAIChatMessageStreaming(
      apiMessages,
      // onProgress
      (progressContent: string) => {
        setProgress(progressContent);
      },
      // onDone
      (response: AIChatStreamDone) => {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: response.content,
            timestamp: new Date(),
            isLoading: false,
            toolCalls: response.tool_calls,
          };
          return updated;
        });
        setIsLoading(false);
        setProgress('');
        inputRef.current?.focus();
      },
      // onError
      (errorMessage: string) => {
        console.error('AI Chat error:', errorMessage);
        setError(errorMessage);
        // Remove loading message on error
        setMessages(prev => prev.slice(0, -1));
        setIsLoading(false);
        setProgress('');
        inputRef.current?.focus();
      }
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function clearChat() {
    setMessages([]);
    setError(null);
    setProgress('');
    setConversationId(generateConversationId());
    localStorage.removeItem(CURRENT_CONVERSATION_KEY);
    localStorage.removeItem(CONVERSATION_ID_KEY);
    inputRef.current?.focus();
  }

  async function handleSaveConversation() {
    if (!saveTitle.trim() || messages.length === 0) return;
    
    const chatMessages: ChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    
    const success = await saveConversation(conversationId, saveTitle.trim(), chatMessages);
    if (success) {
      setShowSaveDialog(false);
      setSaveTitle('');
      await loadSavedConversations();
    } else {
      setError('Failed to save conversation');
    }
  }

  async function handleLoadConversation(id: string) {
    const conversation = await loadConversation(id);
    if (conversation) {
      setMessages(conversation.messages.map(m => ({
        ...m,
        timestamp: new Date(conversation.updated_at),
      })));
      setConversationId(conversation.id);
      setShowSavedPanel(false);
    } else {
      setError('Failed to load conversation');
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!confirm('Delete this conversation?')) return;
    
    const success = await deleteConversation(id);
    if (success) {
      await loadSavedConversations();
    } else {
      setError('Failed to delete conversation');
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🤖 AI Data Assistant</h1>
          <p className="text-sm text-gray-600">
            Ask questions about your trading data, positions, and system configuration
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSavedPanel(!showSavedPanel)}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
          >
            📁 Saved ({savedConversations.length})
          </button>
          {messages.length > 0 && (
            <button
              onClick={() => setShowSaveDialog(true)}
              className="px-3 py-1.5 text-sm text-blue-600 hover:text-blue-900 hover:bg-blue-50 rounded-md transition-colors"
            >
              💾 Save
            </button>
          )}
          <button
            onClick={clearChat}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
          >
            🗑️ New Chat
          </button>
        </div>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Save Conversation</h3>
            <input
              type="text"
              value={saveTitle}
              onChange={(e) => setSaveTitle(e.target.value)}
              placeholder="Enter a title..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md mb-4"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSaveConversation()}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveConversation}
                disabled={!saveTitle.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Saved Conversations Panel */}
      {showSavedPanel && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h3 className="font-semibold mb-2">Saved Conversations</h3>
          {savedConversations.length === 0 ? (
            <p className="text-sm text-gray-500">No saved conversations yet.</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {savedConversations.map((conv) => (
                <div key={conv.id} className="flex items-center justify-between p-2 bg-white rounded border hover:bg-gray-50">
                  <button
                    onClick={() => handleLoadConversation(conv.id)}
                    className="flex-1 text-left"
                  >
                    <div className="font-medium text-sm">{conv.title}</div>
                    <div className="text-xs text-gray-500">
                      {new Date(conv.updated_at).toLocaleDateString()} • {conv.messages.length} messages
                    </div>
                  </button>
                  <button
                    onClick={() => handleDeleteConversation(conv.id)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto bg-white rounded-lg border border-gray-200 p-4 mb-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500">
            <div className="text-4xl mb-4">💬</div>
            <p className="text-lg font-medium mb-2">Start a conversation</p>
            <p className="text-sm text-center max-w-md">
              Ask about your portfolio, recent trades, market data, or system configuration.
              The AI has read-only access to your trading data.
            </p>
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <ExampleQuery onClick={setInput}>What&apos;s my current portfolio value?</ExampleQuery>
              <ExampleQuery onClick={setInput}>Show my trades from the last 24 hours</ExampleQuery>
              <ExampleQuery onClick={setInput}>What mention events are currently active?</ExampleQuery>
              <ExampleQuery onClick={setInput}>Explain the TIS architecture</ExampleQuery>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message, index) => (
              <MessageBubble 
                key={index} 
                message={message} 
                progress={index === messages.length - 1 && message.isLoading ? progress : undefined}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <span className="font-medium">Error:</span> {error}
        </div>
      )}

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your trading data..."
            disabled={isLoading}
            rows={2}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
          <div className="absolute bottom-2 right-2 text-xs text-gray-400">
            Press Enter to send, Shift+Enter for new line
          </div>
        </div>
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors self-start"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <LoadingSpinner />
              Thinking...
            </span>
          ) : (
            'Send'
          )}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message, progress }: { message: DisplayMessage; progress?: string }) {
  const isUser = message.role === 'user';
  const [showToolCalls, setShowToolCalls] = useState(false);
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        {message.isLoading ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <LoadingSpinner />
              <span className="text-gray-500">{progress || 'Connecting...'}</span>
            </div>
          </div>
        ) : isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div>
            {/* Tool calls disclosure */}
            {hasToolCalls && (
              <div className="mb-2">
                <button
                  onClick={() => setShowToolCalls(!showToolCalls)}
                  className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
                >
                  <span className={`transform transition-transform ${showToolCalls ? 'rotate-90' : ''}`}>▶</span>
                  {message.toolCalls!.length} tool{message.toolCalls!.length !== 1 ? 's' : ''} used
                </button>
                {showToolCalls && (
                  <div className="mt-1 pl-3 border-l-2 border-gray-300 text-xs text-gray-500 space-y-0.5">
                    {message.toolCalls!.map((tc, i) => (
                      <div key={i}>• {tc.detail}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="prose prose-sm max-w-none prose-pre:bg-gray-800 prose-pre:text-gray-100">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          </div>
        )}
        <div
          className={`text-xs mt-2 ${
            isUser ? 'text-blue-200' : 'text-gray-400'
          }`}
        >
          {message.timestamp.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

function ExampleQuery({ children, onClick }: { children: string; onClick: (query: string) => void }) {
  return (
    <button
      onClick={() => onClick(children)}
      className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-left text-gray-700 transition-colors"
    >
      {children}
    </button>
  );
}

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
