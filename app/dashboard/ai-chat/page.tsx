'use client';

import { useState, useRef, useEffect } from 'react';
import { sendAIChatMessage, ChatMessage } from '@/lib/api';
import ReactMarkdown from 'react-markdown';

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isLoading?: boolean;
}

export default function AIChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setError(null);

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

    try {
      // Build conversation history for API
      const apiMessages: ChatMessage[] = messages.map(m => ({
        role: m.role,
        content: m.content,
      }));
      apiMessages.push({ role: 'user', content: userMessage });

      // Send to API
      const response = await sendAIChatMessage(apiMessages);

      // Replace loading message with actual response
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: response.response,
          timestamp: new Date(),
          isLoading: false,
        };
        return updated;
      });
    } catch (err: any) {
      console.error('AI Chat error:', err);
      setError(err.message || 'Failed to get response');
      // Remove loading message on error
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
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
    inputRef.current?.focus();
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
        <button
          onClick={clearChat}
          className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
        >
          Clear Chat
        </button>
      </div>

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
              <MessageBubble key={index} message={message} />
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

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === 'user';

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
          <div className="flex items-center gap-2">
            <LoadingSpinner />
            <span className="text-gray-500">Thinking...</span>
          </div>
        ) : isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none prose-pre:bg-gray-800 prose-pre:text-gray-100">
            <ReactMarkdown>{message.content}</ReactMarkdown>
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
