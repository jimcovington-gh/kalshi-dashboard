/**
 * NFL Draft Trader E2E Tests
 *
 * Tests the Draft Trader UI with mocked WebSocket.
 * Covers: connection, initialize, arm/disarm/skip, manual fire,
 * transcript display, audio stats, match alert, pick tracker,
 * ranked bets, fire results, prospect pool, error display,
 * and bridge restart.
 */

import { test, expect, Page } from '@playwright/test';

// ── Mock Data ──────────────────────────────────────────────────────────

const MOCK_STATUS: {
  session_id: string;
  status: string;
  current_pick: number;
  pick_state: string;
  pick_team: string;
  active_prospects: number;
  total_prospects: number;
  picks_completed: number;
  position_counts: Record<string, number>;
  testing_mode: string;
  wallet_limit: number | null;
} = {
  session_id: 'NFL-DRAFT-2026',
  status: 'active',
  current_pick: 1,
  pick_state: 'on_clock',
  pick_team: 'TEN',
  active_prospects: 3,
  total_prospects: 5,
  picks_completed: 0,
  position_counts: {},
  testing_mode: 'dry_run',
  wallet_limit: null,
};

const MOCK_PICKS = [
  { pick_number: 1, team: 'TEN', state: 'on_clock', selected_player: '' },
  { pick_number: 2, team: 'CLE', state: 'upcoming', selected_player: '' },
  { pick_number: 3, team: 'NYG', state: 'upcoming', selected_player: '' },
  { pick_number: 4, team: 'NE', state: 'upcoming', selected_player: '' },
];

const MOCK_PROSPECTS = [
  { name: 'Cam Ward', suffix: 'cam-ward', position: 'QB', drafted: false, drafted_at_pick: 0, drafted_by_team: '' },
  { name: 'Shedeur Sanders', suffix: 'shedeur-sanders', position: 'QB', drafted: false, drafted_at_pick: 0, drafted_by_team: '' },
  { name: 'Travis Hunter', suffix: 'travis-hunter', position: 'WR/CB', drafted: false, drafted_at_pick: 0, drafted_by_team: '' },
  { name: 'Abdul Carter', suffix: 'abdul-carter', position: 'EDGE', drafted: false, drafted_at_pick: 0, drafted_by_team: '' },
  { name: 'Drafted Player', suffix: 'drafted-guy', position: 'RB', drafted: true, drafted_at_pick: 99, drafted_by_team: 'DAL' },
];

const MOCK_AUDIO_STATS = {
  rms: 0.02,
  rms_db: -34.0,
  peak: 0.08,
  peak_db: -22.0,
  clipping: false,
  clip_samples: 0,
  silence: false,
  chunks: 50,
  receiving: true,
  mumble_connected: true,
  queue_size: 2,
  transcripts_final: 5,
  transcripts_partial: 12,
};

const MOCK_RANKED_BETS = [
  {
    ticker: 'NFL-DRAFT-1-CAMWARD-YES',
    side: 'yes',
    player_name: 'Cam Ward',
    market_description: 'Cam Ward 1st overall pick?',
    series_type: 'pick_number',
    contracts: 50,
    total_cost: 22.5,
    total_payout: 50.0,
    projected_profit: 27.5,
    avg_price: 0.45,
    assigned_user: 'jimc',
  },
  {
    ticker: 'NFL-DRAFT-1-CAMWARD-TEAM-YES',
    side: 'no',
    player_name: 'Cam Ward',
    market_description: 'Cam Ward to Tennessee?',
    series_type: 'team',
    contracts: 30,
    total_cost: 9.0,
    total_payout: 30.0,
    projected_profit: 21.0,
    avg_price: 0.30,
    assigned_user: 'andrews',
  },
];

const MOCK_FIRE_RESULT = {
  pick_number: 1,
  player_name: 'Cam Ward',
  bets_attempted: 3,
  buy_results: [
    { ticker: 'NFL-DRAFT-1-CAMWARD-YES', side: 'yes', action: 'buy', success: true, order_id: 'ord-1', contracts_filled: 50, fill_cost_dollars: 22.5, fees_dollars: 0.5, error_code: '', error_message: '' },
    { ticker: 'NFL-DRAFT-1-CAMWARD-TEAM-YES', side: 'no', action: 'buy', success: true, order_id: 'ord-2', contracts_filled: 30, fill_cost_dollars: 9.0, fees_dollars: 0.3, error_code: '', error_message: '' },
  ],
  sell_results: [
    { ticker: 'NFL-DRAFT-1-CAMWARD-YES', side: 'yes', action: 'sell', success: true, order_id: 'ord-3', contracts_filled: 50, fill_cost_dollars: 45.0, fees_dollars: 0.5, error_code: '', error_message: '' },
  ],
  total_cost: 31.5,
  total_potential_profit: 48.5,
  total_latency_ms: 234,
};

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Inject a mock WebSocket into the page that captures sent messages
 * and allows us to push server messages.
 *
 * Must be called BEFORE the page initializes its WS connection.
 */
async function injectMockWebSocket(page: Page) {
  await page.evaluate(() => {
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

      _receive(data: string) {
        const ev = new MessageEvent('message', { data });
        this.onmessage?.(ev);
        this.dispatchEvent(ev);
      }
    }

    (window as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
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
async function getWsSent(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    return ((window as unknown as Record<string, string[]>).__wsSent || []).map((s) => JSON.parse(s));
  });
}

/** Clear the sent messages buffer */
async function clearWsSent(page: Page) {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown[]>).__wsSent = [];
  });
}

/**
 * Navigate to page with mock WS injected BEFORE the page creates its connection.
 * The page auto-connects on mount, so we must inject before navigation completes.
 */
async function gotoWithMockWs(page: Page) {
  // Inject the mock WS early via addInitScript so it's available before React hydration
  await page.addInitScript(() => {
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
      _receive(data: string) {
        const ev = new MessageEvent('message', { data });
        this.onmessage?.(ev);
        this.dispatchEvent(ev);
      }
    }

    (window as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
    (window as unknown as Record<string, unknown>).__OriginalWebSocket = OriginalWebSocket;
  });

  await page.goto('/dashboard/nfl-draft');
  // Wait for React strict-mode double-mount to settle, then WS "connects"
  await expect(page.getByText('CONNECTED', { exact: true })).toBeVisible({ timeout: 10000 });
}

/** Push status + picks + prospects to fully initialize the UI */
async function initializeSession(page: Page) {
  await pushWsMessage(page, { type: 'status', data: MOCK_STATUS });
  await pushWsMessage(page, { type: 'picks', data: MOCK_PICKS });
  await pushWsMessage(page, { type: 'prospects', data: MOCK_PROSPECTS });
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('NFL Draft — Connection & Header', () => {
  test('auto-connects and shows CONNECTED badge', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByText('CONNECTED', { exact: true })).toBeVisible();
    await expect(page.getByText('NFL Draft Trader')).toBeVisible();
  });

  test('shows Initialize Session button before session starts', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByRole('button', { name: 'Initialize Session' })).toBeVisible();
  });

  test('shows mode selector before session starts', async ({ page }) => {
    await gotoWithMockWs(page);

    const modeSelect = page.locator('select').first();
    await expect(modeSelect).toBeVisible();
    // Should contain the 4 modes
    await expect(modeSelect.locator('option')).toHaveCount(4);
  });

  test('shows wallet limit input only for low_wallet mode', async ({ page }) => {
    await gotoWithMockWs(page);

    // Initially dry_run — no wallet input
    await expect(page.locator('input[type="number"]')).not.toBeVisible();

    // Switch to low_wallet
    await page.locator('select').first().selectOption('low_wallet');
    await expect(page.locator('input[type="number"]')).toBeVisible();
  });

  test('shows session info after initialization', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // Mode badge
    await expect(page.getByText('DRY RUN')).toBeVisible();
    // Player count
    await expect(page.getByText('3/5 players')).toBeVisible();
    // P&L
    await expect(page.getByText('P&L:')).toBeVisible();
  });
});

test.describe('NFL Draft — Initialize Session', () => {
  test('Initialize button sends correct WS message (dry_run)', async ({ page }) => {
    await gotoWithMockWs(page);
    await clearWsSent(page);

    await page.getByRole('button', { name: 'Initialize Session' }).click();

    const sent = await getWsSent(page);
    const initMsg = sent.find(m => m.type === 'initialize');
    expect(initMsg).toBeDefined();
    expect(initMsg!.testing_mode).toBe('dry_run');
  });

  test('Initialize with low_wallet sends wallet_limit', async ({ page }) => {
    await gotoWithMockWs(page);
    await clearWsSent(page);

    await page.locator('select').first().selectOption('low_wallet');
    await page.locator('input[type="number"]').fill('250');
    await page.getByRole('button', { name: 'Initialize Session' }).click();

    const sent = await getWsSent(page);
    const initMsg = sent.find(m => m.type === 'initialize');
    expect(initMsg).toBeDefined();
    expect(initMsg!.testing_mode).toBe('low_wallet');
    expect(initMsg!.wallet_limit).toBe(250);
  });

  test('Initialize button disappears after session status received', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await expect(page.getByRole('button', { name: 'Initialize Session' })).not.toBeVisible();
  });
});

test.describe('NFL Draft — Controls (Arm, Disarm, Skip)', () => {
  test('ARM button sends arm message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    await page.getByRole('button', { name: '🎯 ARM' }).click();

    const sent = await getWsSent(page);
    expect(sent.find(m => m.type === 'arm')).toBeDefined();
  });

  test('ARM button is disabled when pick is already armed', async ({ page }) => {
    await gotoWithMockWs(page);
    const armedPicks = MOCK_PICKS.map(p =>
      p.pick_number === 1 ? { ...p, state: 'armed' } : p
    );
    await pushWsMessage(page, { type: 'status', data: { ...MOCK_STATUS, pick_state: 'armed' } });
    await pushWsMessage(page, { type: 'picks', data: armedPicks });
    await pushWsMessage(page, { type: 'prospects', data: MOCK_PROSPECTS });

    await expect(page.getByRole('button', { name: '🎯 ARM' })).toBeDisabled();
  });

  test('DISARM button sends disarm message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    await page.getByRole('button', { name: 'DISARM' }).click();

    const sent = await getWsSent(page);
    expect(sent.find(m => m.type === 'disarm')).toBeDefined();
  });

  test('SKIP button sends skip message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    await page.getByRole('button', { name: 'SKIP' }).click();

    const sent = await getWsSent(page);
    expect(sent.find(m => m.type === 'skip')).toBeDefined();
  });
});

test.describe('NFL Draft — Current Pick Card', () => {
  test('shows current pick number and team', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await expect(page.getByText('#1')).toBeVisible();
    // TEN appears in pick tracker too — use Current Pick card context
    const pickCard = page.locator('.bg-white').filter({ hasText: 'Current Pick' });
    await expect(pickCard.getByText('TEN')).toBeVisible();
    await expect(page.getByText('ON_CLOCK')).toBeVisible();
  });

  test('shows selected player when pick is traded', async ({ page }) => {
    await gotoWithMockWs(page);
    const tradedPicks = MOCK_PICKS.map(p =>
      p.pick_number === 1 ? { ...p, state: 'traded' as const, selected_player: 'Cam Ward' } : p
    );
    await pushWsMessage(page, { type: 'status', data: MOCK_STATUS });
    await pushWsMessage(page, { type: 'picks', data: tradedPicks });
    await pushWsMessage(page, { type: 'prospects', data: MOCK_PROSPECTS });

    await expect(page.getByText('✅ Cam Ward')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('TRADED', { exact: true })).toBeVisible();
  });

  test('shows "No pick active" before status is set', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByText('No pick active')).toBeVisible();
  });
});

test.describe('NFL Draft — Manual Fire', () => {
  test('Manual Fire dropdown is populated with active prospects', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // The select for manual fire — has "Select player..." placeholder
    const fireSelect = page.locator('select').filter({ hasText: 'Select player...' });
    await expect(fireSelect).toBeVisible();

    // Should have 4 active (undrafted) + 1 placeholder = 5 options
    const options = fireSelect.locator('option');
    await expect(options).toHaveCount(5); // placeholder + 4 undrafted
    await expect(options.nth(1)).toContainText('Cam Ward');
    await expect(options.nth(1)).toContainText('QB');
  });

  test('FIRE button is disabled without selection', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await expect(page.getByRole('button', { name: '🔥 FIRE' })).toBeDisabled();
  });

  test('FIRE sends manual_fire with player name', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    const fireSelect = page.locator('select').filter({ hasText: 'Select player...' });
    await fireSelect.selectOption('Cam Ward');
    await page.getByRole('button', { name: '🔥 FIRE' }).click();

    const sent = await getWsSent(page);
    const fireMsg = sent.find(m => m.type === 'manual_fire');
    expect(fireMsg).toBeDefined();
    expect(fireMsg!.player_name).toBe('Cam Ward');
  });

  test('FIRE clears selection after sending', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    const fireSelect = page.locator('select').filter({ hasText: 'Select player...' });
    await fireSelect.selectOption('Cam Ward');
    await page.getByRole('button', { name: '🔥 FIRE' }).click();

    // Dropdown should reset to placeholder
    await expect(fireSelect).toHaveValue('');
  });
});

test.describe('NFL Draft — Team Override', () => {
  test('Team Override sends update_team on selection', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    const teamSelect = page.locator('select').filter({ hasText: 'Select team...' });
    await teamSelect.selectOption('CHI');

    const sent = await getWsSent(page);
    const teamMsg = sent.find(m => m.type === 'update_team');
    expect(teamMsg).toBeDefined();
    expect(teamMsg!.team).toBe('CHI');
    expect(teamMsg!.pick_number).toBe(1);
  });
});

test.describe('NFL Draft — Pick Tracker', () => {
  test('renders pick buttons for each pick', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // Should have 4 pick buttons
    await expect(page.getByText('Pick Tracker')).toBeVisible();
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '4', exact: true })).toBeVisible();
  });

  test('clicking a pick sends advance message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    await page.getByRole('button', { name: '3', exact: true }).click();

    const sent = await getWsSent(page);
    const advMsg = sent.find(m => m.type === 'advance');
    expect(advMsg).toBeDefined();
    expect(advMsg!.pick_number).toBe(3);
  });
});

test.describe('NFL Draft — Ranked Bets', () => {
  test('shows placeholder when no bets', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await expect(page.getByText('Bets will appear when a pick is being processed')).toBeVisible();
  });

  test('renders ranked bets table when bets arrive', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'ranked_bets', data: MOCK_RANKED_BETS });

    await expect(page.getByText('Top Bets (2)')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Cam Ward 1st overall pick?')).toBeVisible();
    await expect(page.getByText('Cam Ward to Tennessee?')).toBeVisible();
    // Check profit column
    await expect(page.getByText('$27.50')).toBeVisible();
    // Check user assignment
    await expect(page.getByText('jimc')).toBeVisible();
    await expect(page.getByText('andrews')).toBeVisible();
  });

  test('shows YES/NO side badges', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await pushWsMessage(page, { type: 'ranked_bets', data: MOCK_RANKED_BETS });

    await expect(page.getByText('YES', { exact: true })).toBeVisible();
    await expect(page.getByText('NO', { exact: true })).toBeVisible();
  });
});

test.describe('NFL Draft — Fire Results / Trade History', () => {
  test('trade history appears after fire_result', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'fire_result', data: MOCK_FIRE_RESULT });

    await expect(page.getByText('Trade History')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Pick #1 — Cam Ward')).toBeVisible();
    await expect(page.getByText('3 bets')).toBeVisible();
    await expect(page.getByText('234ms')).toBeVisible();
    // Buy fill ratio
    await expect(page.getByText('Buys: 2/2 filled')).toBeVisible();
    // Sell count
    await expect(page.getByText('Sells: 1 placed')).toBeVisible();
  });

  test('multiple fire results stack in reverse order', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'fire_result', data: MOCK_FIRE_RESULT });
    await pushWsMessage(page, { type: 'fire_result', data: { ...MOCK_FIRE_RESULT, pick_number: 2, player_name: 'Travis Hunter' } });

    // Most recent should be first (reversed display)
    const tradeEntries = page.locator('text=Pick #');
    await expect(tradeEntries).toHaveCount(2);
    await expect(tradeEntries.first()).toContainText('Pick #2 — Travis Hunter');
    await expect(tradeEntries.last()).toContainText('Pick #1 — Cam Ward');
  });
});

test.describe('NFL Draft — Transcript Display', () => {
  test('shows "Waiting for audio..." when no transcripts', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByText('Waiting for audio...')).toBeVisible();
  });

  test('final transcripts appear in feed', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, {
      type: 'transcript',
      data: { text: 'the first pick of the 2026 NFL draft', is_final: true, timestamp: Date.now(), source: 'mumble' },
    });

    await expect(page.getByText('the first pick of the 2026 NFL draft')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('[mumble]')).toBeVisible();
  });

  test('partial transcripts appear differently', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, {
      type: 'transcript',
      data: { text: 'the first pick', is_final: false, timestamp: Date.now(), source: 'riva' },
    });

    await expect(page.getByText('the first pick')).toBeVisible({ timeout: 3000 });
  });

  test('transcript inject sends WS message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    const input = page.locator('input[placeholder="Inject test transcript..."]');
    await input.fill('Caleb Williams');
    await page.getByRole('button', { name: 'Send' }).click();

    const sent = await getWsSent(page);
    const txMsg = sent.find(m => m.type === 'transcript');
    expect(txMsg).toBeDefined();
    expect(txMsg!.text).toBe('Caleb Williams');
    expect(txMsg!.is_final).toBe(true);
    expect(txMsg!.source).toBe('manual');
  });

  test('transcript inject clears input after send', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    const input = page.locator('input[placeholder="Inject test transcript..."]');
    await input.fill('test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(input).toHaveValue('');
  });

  test('transcript inject works with Enter key', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    const input = page.locator('input[placeholder="Inject test transcript..."]');
    await input.fill('Shedeur Sanders');
    await input.press('Enter');

    const sent = await getWsSent(page);
    expect(sent.find(m => m.type === 'transcript')).toBeDefined();
  });

  test('Send button is disabled when input is empty', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

test.describe('NFL Draft — Audio Stats & Mumble Bridge', () => {
  test('shows bridge offline when no stats received', async ({ page }) => {
    await gotoWithMockWs(page);

    await expect(page.getByText('Bridge Offline')).toBeVisible();
    await expect(page.getByText('Bridge is not sending data')).toBeVisible();
  });

  test('shows bridge active with audio stats', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'audio_stats', data: MOCK_AUDIO_STATS });

    await expect(page.getByText('Bridge Active')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Mumble Connected')).toBeVisible();
    await expect(page.getByText('Audio Receiving')).toBeVisible();
    await expect(page.getByText('Good Signal')).toBeVisible();
  });

  test('shows RMS and peak dBFS readings', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await pushWsMessage(page, { type: 'audio_stats', data: MOCK_AUDIO_STATS });

    await expect(page.getByText('RMS -34 dBFS')).toBeVisible();
    await expect(page.getByText('Peak -22 dBFS')).toBeVisible();
  });

  test('shows transcript counters', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await pushWsMessage(page, { type: 'audio_stats', data: MOCK_AUDIO_STATS });

    await expect(page.getByText('Finals: 5')).toBeVisible();
    await expect(page.getByText('Partials: 12')).toBeVisible();
  });

  test('shows clipping alert when audio clips', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'audio_stats', data: { ...MOCK_AUDIO_STATS, clipping: true, clip_samples: 42 } });

    await expect(page.getByText('CLIPPING (42)')).toBeVisible({ timeout: 3000 });
  });

  test('shows silence when audio is silent', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'audio_stats', data: { ...MOCK_AUDIO_STATS, silence: true, receiving: false } });

    await expect(page.getByText('Silence')).toBeVisible({ timeout: 3000 });
  });

  test('shows mumble disconnected', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'audio_stats', data: { ...MOCK_AUDIO_STATS, mumble_connected: false } });

    await expect(page.getByText('Mumble Disconnected')).toBeVisible({ timeout: 3000 });
  });

  test('Restart Bridge button sends POST to /bridge/restart', async ({ page }) => {
    await gotoWithMockWs(page);

    // Mock the bridge restart API
    let restartCalled = false;
    await page.route('**/bridge/restart', (route) => {
      restartCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
    });

    await page.getByRole('button', { name: '🔄 Restart Bridge' }).click();

    // Button should show restarting state
    await expect(page.getByText('⏳ Restarting...')).toBeVisible();

    // After 3s timeout, should revert
    await expect(page.getByText('🔄 Restart Bridge')).toBeVisible({ timeout: 5000 });

    expect(restartCalled).toBe(true);
  });

  test('Bridge restart failure shows error', async ({ page }) => {
    await gotoWithMockWs(page);

    await page.route('**/bridge/restart', (route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Service unavailable"}' });
    });

    await page.getByRole('button', { name: '🔄 Restart Bridge' }).click();

    await expect(page.getByText('Bridge restart failed: Service unavailable')).toBeVisible({ timeout: 3000 });
  });
});

test.describe('NFL Draft — Match Alert', () => {
  test('match alert shows player name with flash', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'match', data: { player_name: 'Cam Ward' } });

    await expect(page.getByText('MATCHED: Cam Ward — FIRING ORDERS')).toBeVisible({ timeout: 3000 });
  });

  test('match alert auto-clears after 5 seconds', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'match', data: { player_name: 'Cam Ward' } });
    await expect(page.getByText('MATCHED: Cam Ward')).toBeVisible({ timeout: 3000 });

    // Wait for 5s auto-clear + buffer
    await expect(page.getByText('MATCHED: Cam Ward')).not.toBeVisible({ timeout: 7000 });
  });
});

test.describe('NFL Draft — Prospect Pool', () => {
  test('shows active prospects count', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // 4 undrafted = active
    await expect(page.getByText('Prospect Pool (4 active)')).toBeVisible();
  });

  test('renders all prospects with position', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // Use prospect pool section to avoid matching Manual Fire dropdown
    const pool = page.locator('.bg-white').filter({ hasText: 'Prospect Pool' });
    await expect(pool.getByText('Cam Ward')).toBeVisible();
    await expect(pool.getByText('Shedeur Sanders')).toBeVisible();
    await expect(pool.getByText('Travis Hunter')).toBeVisible();
    await expect(pool.getByText('Abdul Carter')).toBeVisible();
    // Position
    await expect(pool.getByText('WR/CB')).toBeVisible();
    await expect(pool.getByText('EDGE')).toBeVisible();
  });

  test('active prospects show Active badge', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    const activeBadges = page.getByText('Active', { exact: true });
    await expect(activeBadges).toHaveCount(4); // 4 undrafted
  });

  test('drafted prospect shows pick info', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await expect(page.getByText('#99 → DAL')).toBeVisible();
  });

  test('Remove button sends remove WS message', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);
    await clearWsSent(page);

    // Click the ✕ next to Cam Ward — use title attribute
    await page.locator('button[title="Remove Cam Ward"]').click();

    const sent = await getWsSent(page);
    const removeMsg = sent.find(m => m.type === 'remove');
    expect(removeMsg).toBeDefined();
    expect(removeMsg!.player_name).toBe('Cam Ward');
  });

  test('drafted prospects do not have remove button', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    // Only 4 remove buttons (one per undrafted prospect) — title="Remove {name}"
    const removeButtons = page.locator('button[title^="Remove"]');
    await expect(removeButtons).toHaveCount(4);
  });
});

test.describe('NFL Draft — Error Display', () => {
  test('error messages appear in error panel', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'error', data: { message: 'Initialize failed: Set changed size during iteration' } });

    await expect(page.getByText('Initialize failed: Set changed size during iteration')).toBeVisible({ timeout: 3000 });
  });

  test('multiple errors stack', async ({ page }) => {
    await gotoWithMockWs(page);
    await initializeSession(page);

    await pushWsMessage(page, { type: 'error', data: { message: 'Error 1' } });
    await pushWsMessage(page, { type: 'error', data: { message: 'Error 2' } });

    await expect(page.getByText('Error 1')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Error 2')).toBeVisible();
  });
});

test.describe('NFL Draft — Position Counts', () => {
  test('shows position counts when available', async ({ page }) => {
    await gotoWithMockWs(page);

    await pushWsMessage(page, {
      type: 'status',
      data: { ...MOCK_STATUS, position_counts: { QB: 2, WR: 3, EDGE: 1 } },
    });
    await pushWsMessage(page, { type: 'picks', data: MOCK_PICKS });
    await pushWsMessage(page, { type: 'prospects', data: MOCK_PROSPECTS });

    await expect(page.getByText('Positions Drafted')).toBeVisible({ timeout: 3000 });
    // Use position counts section to avoid matching prospect pool
    const posSection = page.locator('.bg-white').filter({ hasText: 'Positions Drafted' });
    await expect(posSection.locator('div').filter({ hasText: /^QB$/ })).toBeVisible();
    await expect(posSection.locator('div').filter({ hasText: /^WR$/ })).toBeVisible();
    await expect(posSection.locator('div').filter({ hasText: /^EDGE$/ })).toBeVisible();
  });
});

test.describe('NFL Draft — Ping Keepalive', () => {
  test('client sends ping messages periodically', async ({ page }) => {
    await gotoWithMockWs(page);

    // Wait long enough for at least one ping (15s interval)
    await page.waitForTimeout(16000);

    const sent = await getWsSent(page);
    const pings = sent.filter(m => m.type === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('NFL Draft — Full Flow', () => {
  test('initialize → arm → match → fire → traded', async ({ page }) => {
    await gotoWithMockWs(page);

    // 1. Initialize
    await page.getByRole('button', { name: 'Initialize Session' }).click();

    // Server responds with session data
    await initializeSession(page);
    await expect(page.getByText('DRY RUN')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('#1')).toBeVisible();

    // 2. Arm
    await page.getByRole('button', { name: '🎯 ARM' }).click();
    const armedPicks = MOCK_PICKS.map(p =>
      p.pick_number === 1 ? { ...p, state: 'armed' } : p
    );
    await pushWsMessage(page, { type: 'status', data: { ...MOCK_STATUS, pick_state: 'armed' } });
    await pushWsMessage(page, { type: 'picks', data: armedPicks });
    await expect(page.getByText('ARMED')).toBeVisible({ timeout: 3000 });

    // 3. Transcript comes in
    await pushWsMessage(page, {
      type: 'transcript',
      data: { text: 'Tennessee selects Cam Ward quarterback from Miami', is_final: true, timestamp: Date.now(), source: 'mumble' },
    });
    await expect(page.getByText('Tennessee selects Cam Ward quarterback from Miami')).toBeVisible({ timeout: 3000 });

    // 4. Match alert
    await pushWsMessage(page, { type: 'match', data: { player_name: 'Cam Ward' } });
    await expect(page.getByText('MATCHED: Cam Ward — FIRING ORDERS')).toBeVisible({ timeout: 3000 });

    // 5. Ranked bets appear
    await pushWsMessage(page, { type: 'ranked_bets', data: MOCK_RANKED_BETS });
    await expect(page.getByText('Top Bets (2)')).toBeVisible({ timeout: 3000 });

    // 6. Picks transition to firing
    const firingPicks = MOCK_PICKS.map(p =>
      p.pick_number === 1 ? { ...p, state: 'firing' } : p
    );
    await pushWsMessage(page, { type: 'picks', data: firingPicks });
    await expect(page.getByText('FIRING', { exact: true })).toBeVisible({ timeout: 3000 });

    // 7. Fire result
    await pushWsMessage(page, { type: 'fire_result', data: MOCK_FIRE_RESULT });
    await expect(page.getByText('Trade History')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Pick #1 — Cam Ward')).toBeVisible();

    // 8. Pick traded, advance to next
    const tradedPicks = MOCK_PICKS.map(p =>
      p.pick_number === 1 ? { ...p, state: 'traded', selected_player: 'Cam Ward' } :
        p.pick_number === 2 ? { ...p, state: 'on_clock' } : p
    );
    await pushWsMessage(page, { type: 'status', data: { ...MOCK_STATUS, current_pick: 2, picks_completed: 1, pick_team: 'CLE' } });
    await pushWsMessage(page, { type: 'picks', data: tradedPicks });
    await expect(page.getByText('#2')).toBeVisible();
    // CLE appears in team override dropdown too
    const pickCard = page.locator('.bg-white').filter({ hasText: 'Current Pick' });
    await expect(pickCard.getByText('CLE')).toBeVisible();
  });
});
