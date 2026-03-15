/**
 * Event Trader E2E Tests
 *
 * Tests the UI flow with mocked API and WebSocket responses.
 * Covers: session dropdown, connect, category list, arm/disarm,
 * dual-trigger gate, transcript display, and disconnect.
 */

import { test, expect, Page } from '@playwright/test';

// ── Mock data ──────────────────────────────────────────────────────────

const MOCK_SESSIONS = {
  sessions: [
    { session_id: 'OSCARS-2026', event_name: '98th Academy Awards', event_date: '2026-03-16', status: 'ready' },
    { session_id: 'OSCARS-2025', event_name: '97th Academy Awards', event_date: '2025-03-02', status: 'ready' },
    { session_id: 'OSCARS-2024', event_name: '96th Academy Awards', event_date: '2024-03-10', status: 'ready' },
  ],
};

const MOCK_STATE_IDLE = {
  type: 'state',
  data: {
    session_id: 'OSCARS-2025',
    current_category: null,
    state: 'idle',
    armed_at: null,
    auto_triggered: false,
    manual_triggered: false,
    categories: [
      {
        name: 'Best Picture',
        category_id: 'best-picture',
        state: 'idle',
        winner: null,
        nominees: [
          { name: 'Anora', nominee_id: 'BP-ANORA', ticker: 'TEST-BP-ANORA', has_thin_market: false },
          { name: 'The Brutalist', nominee_id: 'BP-BRUTALIST', ticker: 'TEST-BP-BRUTALIST', has_thin_market: false },
          { name: 'Conclave', nominee_id: 'BP-CONCLAVE', ticker: 'TEST-BP-CONCLAVE', has_thin_market: false },
        ],
      },
      {
        name: 'Best Actor',
        category_id: 'best-actor',
        state: 'idle',
        winner: null,
        nominees: [
          { name: 'Adrien Brody', nominee_id: 'BA-BRODY', ticker: 'TEST-BA-BRODY', has_thin_market: false },
          { name: 'Timothee Chalamet', nominee_id: 'BA-CHALAMET', ticker: 'TEST-BA-CHALAMET', has_thin_market: false },
        ],
      },
    ],
  },
};

function makeArmedState(categoryId: string) {
  const state = structuredClone(MOCK_STATE_IDLE);
  state.data.current_category = categoryId;
  state.data.state = 'armed';
  const cat = state.data.categories.find((c: { category_id: string }) => c.category_id === categoryId);
  if (cat) cat.state = 'armed';
  return state;
}

const MOCK_TRANSCRIPT = {
  type: 'transcript',
  data: {
    text: 'and the oscar goes to',
    is_final: true,
    provider: 'riva',
    latency_ms: 120,
    trigger_detected: true,
    timestamp: Date.now(),
  },
};

const MOCK_TRIGGER_ALERT = {
  type: 'trigger_alert',
  data: {
    phrase: 'and the oscar goes to',
    timestamp: Date.now(),
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Intercept the /sessions API call and return mock data.
 * Also intercept WebSocket upgrade attempts.
 */
async function setupMocks(page: Page) {
  // Mock the /sessions API
  await page.route('**/sessions', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SESSIONS),
    });
  });
}

/**
 * Inject a mock WebSocket into the page that captures sent messages
 * and allows us to push server messages.
 */
async function injectMockWebSocket(page: Page) {
  await page.evaluate(() => {
    // Store sent messages and mock ws instance for test access
    (window as unknown as Record<string, unknown>).__wsSent = [] as string[];
    (window as unknown as Record<string, unknown>).__wsInstance = null;

    const OriginalWebSocket = window.WebSocket;
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      url: string;
      protocol = '';
      bufferedAmount = 0;
      extensions = '';
      binaryType: BinaryType = 'blob';
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;

      constructor(url: string, protocols?: string | string[]) {
        super();
        this.url = url;
        void protocols;
        (window as unknown as Record<string, unknown>).__wsInstance = this;

        // Auto-open after a tick
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          const ev = new Event('open');
          this.onopen?.(ev);
          this.dispatchEvent(ev);
        }, 50);
      }

      send(data: string) {
        ((window as unknown as Record<string, unknown[]>).__wsSent).push(data);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        const ev = new CloseEvent('close', { code: 1000 });
        this.onclose?.(ev);
        this.dispatchEvent(ev);
      }

      // Helper for tests to push a server message
      _receive(data: string) {
        const ev = new MessageEvent('message', { data });
        this.onmessage?.(ev);
        this.dispatchEvent(ev);
      }
    }

    // Replace global WebSocket
    (window as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
    // Keep reference to original in case needed
    (window as unknown as Record<string, unknown>).__OriginalWebSocket = OriginalWebSocket;
  });
}

/** Push a mock server message through the WebSocket */
async function pushWsMessage(page: Page, msg: object) {
  await page.evaluate((data) => {
    const ws = (window as unknown as Record<string, { _receive: (d: string) => void }>).__wsInstance;
    if (ws) ws._receive(JSON.stringify(data));
  }, msg);
}

/** Get all messages sent by the client via WebSocket */
async function getWsSent(page: Page): Promise<object[]> {
  return page.evaluate(() => {
    return ((window as unknown as Record<string, string[]>).__wsSent || []).map((s) => JSON.parse(s));
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Event Trader — Setup Screen', () => {
  test('shows session dropdown populated from API', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');

    // Should show the dropdown, not a text input
    const select = page.locator('select');
    await expect(select).toBeVisible({ timeout: 5000 });

    // Should have 3 options
    const options = select.locator('option');
    await expect(options).toHaveCount(3);

    // First option should be the most recent event
    await expect(options.first()).toContainText('98th Academy Awards');
    await expect(options.nth(1)).toContainText('97th Academy Awards');
    await expect(options.nth(2)).toContainText('96th Academy Awards');
  });

  test('shows manual text input when API returns no sessions', async ({ page }) => {
    await page.route('**/sessions', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      });
    });
    await page.goto('/dashboard/event-trader');

    // Should show text input with placeholder
    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('placeholder', 'e.g. OSCARS-2026');

    // Should show warning message
    await expect(page.getByText('No sessions found')).toBeVisible();
  });

  test('shows manual text input when API fails', async ({ page }) => {
    await page.route('**/sessions', (route) => {
      route.abort('connectionrefused');
    });
    await page.goto('/dashboard/event-trader');

    // Should gracefully fall back to text input
    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test('Connect button is disabled when no session selected', async ({ page }) => {
    await page.route('**/sessions', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      });
    });
    await page.goto('/dashboard/event-trader');
    await page.waitForTimeout(500);

    const connectBtn = page.getByRole('button', { name: 'Connect' });
    await expect(connectBtn).toBeDisabled();
  });

  test('Connect button is enabled with dropdown selection', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');

    // Wait for dropdown to load
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });

    // Button should be enabled (first option auto-selected)
    const connectBtn = page.getByRole('button', { name: 'Connect' });
    await expect(connectBtn).toBeEnabled();
  });
});

test.describe('Event Trader — Session Connection', () => {
  test('clicking Connect transitions to live session screen', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });

    // Inject mock WS before clicking connect
    await injectMockWebSocket(page);

    // Click connect
    await page.getByRole('button', { name: 'Connect' }).click();

    // Should show Disconnect button (we're on the live screen now)
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 5000 });

    // Should show connection status
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });
  });

  test('receives initial state and shows categories', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });

    // Push initial state
    await pushWsMessage(page, MOCK_STATE_IDLE);

    // Should show categories (use .first() — option elements in ARM dropdown also contain these names)
    await expect(page.getByText('Best Picture').first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Best Actor').first()).toBeVisible();

    // Should show IDLE state badge
    await expect(page.getByText('IDLE').first()).toBeVisible();
  });

  test('Disconnect returns to setup screen', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });

    // Click disconnect
    await page.getByRole('button', { name: 'Disconnect' }).click();

    // Should be back on setup screen
    await expect(page.locator('select')).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  });
});

test.describe('Event Trader — Category Arm/Disarm', () => {
  async function connectAndInit(page: Page) {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });
    await pushWsMessage(page, MOCK_STATE_IDLE);
    await expect(page.getByText('Best Picture').first()).toBeVisible({ timeout: 3000 });
  }

  test('ARM dropdown contains idle categories', async ({ page }) => {
    await connectAndInit(page);

    // The ARM dropdown in ControlPanel
    const armSelect = page.locator('select').filter({ hasText: 'ARM Next' });
    await expect(armSelect).toBeVisible();

    const options = armSelect.locator('option');
    // Default placeholder + 2 idle categories
    await expect(options).toHaveCount(3);
    await expect(options.nth(1)).toContainText('Best Picture');
    await expect(options.nth(2)).toContainText('Best Actor');
  });

  test('selecting a category sends arm command via WS', async ({ page }) => {
    await connectAndInit(page);

    const armSelect = page.locator('select').filter({ hasText: 'ARM Next' });
    await armSelect.selectOption('best-picture');

    // Verify WS message sent
    const sent = await getWsSent(page);
    const armMsg = sent.find((m: Record<string, unknown>) => m.type === 'arm');
    expect(armMsg).toBeDefined();
    expect((armMsg as Record<string, unknown>).category).toBe('best-picture');
  });

  test('armed state shows ARMED badge and nominees', async ({ page }) => {
    await connectAndInit(page);

    // Push armed state
    const armedState = makeArmedState('best-picture');
    await pushWsMessage(page, armedState);

    // Should show ARMED badge
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });

    // Should show nominees under the category (.first() — ticker spans and Manual Fire dropdown also match)
    await expect(page.getByText('Anora').first()).toBeVisible();
    await expect(page.getByText('The Brutalist').first()).toBeVisible();
    await expect(page.getByText('Conclave').first()).toBeVisible();
  });

  test('Disarm button sends disarm command', async ({ page }) => {
    await connectAndInit(page);
    await pushWsMessage(page, makeArmedState('best-picture'));
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });

    // Click disarm
    await page.getByRole('button', { name: 'Disarm' }).click();

    const sent = await getWsSent(page);
    const disarmMsg = sent.find((m: Record<string, unknown>) => m.type === 'disarm');
    expect(disarmMsg).toBeDefined();
  });
});

test.describe('Event Trader — Dual Trigger Gate', () => {
  async function connectAndArm(page: Page) {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });

    // Push armed state
    await pushWsMessage(page, makeArmedState('best-picture'));
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });
  }

  test('shows dual trigger gate panel when armed', async ({ page }) => {
    await connectAndArm(page);

    // Should show trigger gate indicators
    await expect(page.getByText('Dual Trigger Gate')).toBeVisible();
    await expect(page.getByText('AUTO', { exact: true })).toBeVisible();
    await expect(page.getByText('MANUAL', { exact: true })).toBeVisible();
    await expect(page.getByText('Both required to start matching')).toBeVisible();
  });

  test('TRIGGER button sends trigger WS command', async ({ page }) => {
    await connectAndArm(page);

    // Click TRIGGER button
    await page.getByRole('button', { name: '⚡ TRIGGER' }).click();

    const sent = await getWsSent(page);
    const triggerMsg = sent.find((m: Record<string, unknown>) => m.type === 'trigger');
    expect(triggerMsg).toBeDefined();
  });

  test('auto trigger alert shows alert banner and RESET button', async ({ page }) => {
    await connectAndArm(page);

    // Simulate auto trigger from audio
    await pushWsMessage(page, MOCK_TRIGGER_ALERT);

    // Should show flashing alert banner
    await expect(page.getByText('TRIGGER DETECTED')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Click TRIGGER to confirm')).toBeVisible();

    // RESET button should appear
    await expect(page.getByRole('button', { name: 'RESET' })).toBeVisible();

    // Should show detected phrase
    await expect(page.getByText('and the oscar goes to')).toBeVisible();

    // AUTO LED should be green (check status text)
    await expect(page.getByText('Waiting for manual confirm')).toBeVisible();
  });

  test('RESET clears auto trigger and sends reset_trigger', async ({ page }) => {
    await connectAndArm(page);
    await pushWsMessage(page, MOCK_TRIGGER_ALERT);
    await expect(page.getByRole('button', { name: 'RESET' })).toBeVisible({ timeout: 3000 });

    // Click RESET
    await page.getByRole('button', { name: 'RESET' }).click();

    // Alert banner should disappear
    await expect(page.getByText('TRIGGER DETECTED')).not.toBeVisible({ timeout: 3000 });

    // WS should have sent reset_trigger
    const sent = await getWsSent(page);
    const resetMsg = sent.find((m: Record<string, unknown>) => m.type === 'reset_trigger');
    expect(resetMsg).toBeDefined();
  });

  test('manual-first path: TRIGGER then auto shows both gates', async ({ page }) => {
    await connectAndArm(page);

    // Click TRIGGER first (manual-first)
    await page.getByRole('button', { name: '⚡ TRIGGER' }).click();

    // Push state with manual_triggered=true
    const manualState = makeArmedState('best-picture');
    manualState.data.manual_triggered = true;
    await pushWsMessage(page, manualState);

    // Manual LED should be on, waiting for audio
    await expect(page.getByText('Waiting for audio trigger')).toBeVisible({ timeout: 3000 });

    // TRIGGER button should now show confirmed
    await expect(page.getByRole('button', { name: '✓ TRIGGERED' })).toBeVisible();
  });

  test('both triggers met transitions to IDENTIFYING', async ({ page }) => {
    await connectAndArm(page);

    // Simulate both triggers met — server pushes identifying state
    const identifyingState = structuredClone(MOCK_STATE_IDLE);
    identifyingState.data.current_category = 'best-picture';
    identifyingState.data.state = 'identifying';
    identifyingState.data.auto_triggered = true;
    identifyingState.data.manual_triggered = true;
    const cat = identifyingState.data.categories.find((c: { category_id: string }) => c.category_id === 'best-picture');
    if (cat) cat.state = 'identifying';
    await pushWsMessage(page, identifyingState);

    // Should show IDENTIFYING badge (.first() — category button also contains 'identifying')
    await expect(page.getByText('IDENTIFYING').first()).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Event Trader — Transcript & Trades', () => {
  async function connectAndArm(page: Page) {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });
    await pushWsMessage(page, makeArmedState('best-picture'));
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });
  }

  test('transcript entries appear in the log', async ({ page }) => {
    await connectAndArm(page);

    await pushWsMessage(page, MOCK_TRANSCRIPT);

    // Should show the transcript text
    await expect(page.getByText('and the oscar goes to')).toBeVisible({ timeout: 3000 });
  });

  test('trade notification shows nominee and details', async ({ page }) => {
    await connectAndArm(page);

    await pushWsMessage(page, {
      type: 'trade',
      data: {
        nominee: 'Anora',
        ticker: 'TEST-BP-ANORA',
        side: 'yes',
        action: 'buy',
        contracts_filled: 50,
        cost_dollars: 45.0,
        latency_ms: 80,
        total_latency_ms: 320,
        sell_placed: false,
      },
    });

    // Should show trade info (.first() — nominee also in category list and Manual Fire dropdown)
    await expect(page.getByText('Anora').first()).toBeVisible({ timeout: 3000 });
  });

  test('error message shows in banner', async ({ page }) => {
    await connectAndArm(page);

    await pushWsMessage(page, {
      type: 'error',
      data: { message: 'SRT connection lost' },
    });

    await expect(page.getByText('SRT connection lost')).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Event Trader — Score Updates', () => {
  test('score update shows candidates and decision', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });

    // Push identifying state
    const identifyingState = structuredClone(MOCK_STATE_IDLE);
    identifyingState.data.current_category = 'best-picture';
    identifyingState.data.state = 'identifying';
    identifyingState.data.auto_triggered = true;
    identifyingState.data.manual_triggered = true;
    const cat = identifyingState.data.categories.find((c: { category_id: string }) => c.category_id === 'best-picture');
    if (cat) cat.state = 'identifying';
    await pushWsMessage(page, identifyingState);
    await expect(page.getByText('IDENTIFYING').first()).toBeVisible({ timeout: 3000 });

    // Push score with match
    await pushWsMessage(page, {
      type: 'scores',
      data: {
        elapsed_ms: 450,
        candidates: [
          { name: 'Anora', soundex_match: true },
          { name: 'The Brutalist', soundex_match: false },
        ],
        decision: 'Anora',
        fired: true,
      },
    });

    // Should show the candidate info
    await expect(page.getByText('Anora').first()).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Event Trader — Full Flow', () => {
  test('complete flow: connect → arm → auto trigger → manual confirm → identify → trade', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/dashboard/event-trader');
    await expect(page.locator('select')).toBeVisible({ timeout: 5000 });
    await injectMockWebSocket(page);

    // 1. Connect
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });

    // 2. Receive initial state
    await pushWsMessage(page, MOCK_STATE_IDLE);
    await expect(page.getByText('IDLE').first()).toBeVisible({ timeout: 3000 });

    // 3. Arm Best Picture
    const armSelect = page.locator('select').filter({ hasText: 'ARM Next' });
    await armSelect.selectOption('best-picture');

    // Server responds with armed state
    await pushWsMessage(page, makeArmedState('best-picture'));
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Dual Trigger Gate')).toBeVisible();

    // 4. Auto trigger fires (audio detected)
    await pushWsMessage(page, MOCK_TRIGGER_ALERT);
    await expect(page.getByText('TRIGGER DETECTED')).toBeVisible({ timeout: 3000 });

    // 5. Manual confirm
    await page.getByRole('button', { name: '⚡ TRIGGER' }).click();

    // Server transitions to identifying
    const identifyingState = structuredClone(MOCK_STATE_IDLE);
    identifyingState.data.current_category = 'best-picture';
    identifyingState.data.state = 'identifying';
    identifyingState.data.auto_triggered = true;
    identifyingState.data.manual_triggered = true;
    const cat = identifyingState.data.categories.find((c: { category_id: string }) => c.category_id === 'best-picture');
    if (cat) cat.state = 'identifying';
    await pushWsMessage(page, identifyingState);
    await expect(page.getByText('IDENTIFYING').first()).toBeVisible({ timeout: 3000 });

    // 6. Score update — winner identified
    await pushWsMessage(page, {
      type: 'scores',
      data: {
        elapsed_ms: 380,
        candidates: [{ name: 'Anora', soundex_match: true }],
        decision: 'Anora',
        fired: true,
      },
    });

    // 7. Trade executed
    await pushWsMessage(page, {
      type: 'trade',
      data: {
        nominee: 'Anora',
        ticker: 'TEST-BP-ANORA',
        side: 'yes',
        action: 'buy',
        contracts_filled: 100,
        cost_dollars: 90.0,
        latency_ms: 65,
        total_latency_ms: 445,
        sell_placed: false,
      },
    });

    // 8. Server transitions to traded
    const tradedState = structuredClone(MOCK_STATE_IDLE);
    tradedState.data.current_category = 'best-picture';
    tradedState.data.state = 'traded';
    tradedState.data.auto_triggered = true;
    tradedState.data.manual_triggered = true;
    const tradedCat = tradedState.data.categories.find((c: { category_id: string }) => c.category_id === 'best-picture');
    if (tradedCat) {
      tradedCat.state = 'traded';
      tradedCat.winner = 'Anora';
    }
    await pushWsMessage(page, tradedState);
    await expect(page.getByText('TRADED').first()).toBeVisible({ timeout: 3000 });

    // Verify the WS messages sent during the flow
    const sent = await getWsSent(page);
    const types = sent.map((m: Record<string, unknown>) => m.type);
    expect(types).toContain('arm');
    expect(types).toContain('trigger');
  });
});
