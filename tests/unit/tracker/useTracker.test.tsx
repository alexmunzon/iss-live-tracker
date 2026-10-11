// Coordinator-owned hook tests: A05/A09/A10 integration of the one scheduler into React.
import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/app/App';
import type { TrackerEnvironment } from '../../../src/features/tracker/useTracker';
import { rawPosition } from '../../fixtures/canonical';
import { FakeEnv, flushMicrotasks } from '../data/fakes';

function setup(options: { visible?: boolean; online?: boolean } = {}) {
  const fake = new FakeEnv();
  const calls: RequestInit[] = [];
  let visible = options.visible ?? true;
  const env: TrackerEnvironment = {
    fetch: (_url, init) => {
      calls.push(init);
      const body = JSON.stringify(rawPosition({ timestamp: Math.floor(fake.wall / 1000) }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    },
    clock: fake.clock,
    timers: fake.timers,
    random: () => 0,
    isVisible: () => visible,
    isOnline: () => options.online ?? true,
  };
  const step = async (ms: number) => {
    await act(async () => {
      await fake.advance(ms);
      await flushMicrotasks();
    });
  };
  return {
    fake,
    calls,
    env,
    step,
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}

describe('useTracker + App', () => {
  it('A10 Strict Mode double setup makes exactly one first request', async () => {
    const t = setup();
    render(
      <StrictMode>
        <App environment={t.env} />
      </StrictMode>,
    );
    await t.step(0);
    expect(t.calls).toHaveLength(1);
    await t.step(4_999);
    expect(t.calls).toHaveLength(1);
    await t.step(1);
    expect(t.calls).toHaveLength(2);
  });

  it('A10 unmount disposes the scheduler, clears every timer and stops requests', async () => {
    const t = setup();
    const { unmount } = render(<App environment={t.env} />);
    await t.step(12_000);
    const count = t.calls.length;
    unmount();
    expect(t.fake.pendingCount).toBe(0);
    await t.step(60_000);
    expect(t.calls).toHaveLength(count);
  });

  it('A10 remount after unmount starts one fresh scheduler', async () => {
    const t = setup();
    const first = render(<App environment={t.env} />);
    await t.step(0);
    first.unmount();
    render(<App environment={t.env} />);
    await t.step(0);
    expect(t.calls).toHaveLength(2);
    expect(t.fake.pendingCount).toBeGreaterThan(0);
  });

  it('A05 age text advances on the display tick without extra requests', async () => {
    const t = setup();
    render(<App environment={t.env} />);
    await t.step(0);
    expect(screen.getAllByText(/0 seconds ago|just now/i).length).toBeGreaterThan(0);
    // Pause so only the display tick runs.
    await act(async () => {
      screen.getByRole('button', { name: /pause updates/i }).click();
      await flushMicrotasks();
    });
    const count = t.calls.length;
    await t.step(3_000);
    expect(screen.getAllByText(/3 seconds ago/i).length).toBeGreaterThan(0);
    expect(t.calls).toHaveLength(count);
  });

  it('A09 visibilitychange is wired: hidden stops requests, visible resumes once', async () => {
    const t = setup();
    render(<App environment={t.env} />);
    await t.step(0);
    t.setVisible(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });
    const count = t.calls.length;
    await t.step(60_000);
    expect(t.calls).toHaveLength(count);
    t.setVisible(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });
    expect(t.calls).toHaveLength(count + 1);
  });

  it('A09 offline event stops automatic requests; online resumes', async () => {
    const t = setup();
    render(<App environment={t.env} />);
    await t.step(0);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await flushMicrotasks();
    });
    const count = t.calls.length;
    await t.step(30_000);
    expect(t.calls).toHaveLength(count);
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await flushMicrotasks();
    });
    expect(t.calls).toHaveLength(count + 1);
  });

  it('G1-v2 API requests never send a referrer and never send credentials', async () => {
    const t = setup();
    render(<App environment={t.env} />);
    await t.step(0);
    expect(t.calls[0]).toMatchObject({ referrerPolicy: 'no-referrer', credentials: 'omit' });
  });
});
