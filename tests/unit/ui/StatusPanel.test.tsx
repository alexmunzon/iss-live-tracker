import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusPanel } from '../../../src/features/status/StatusPanel';
import { TrackerLayout } from '../../../src/features/status/TrackerLayout';
import {
  makeView,
  previewAnchor,
  previewSample,
  previewViews,
} from '../../../src/features/status/fixtures';
import type { MapStatus, TrackerView } from '../../../src/domain/position';

function renderPanel(view: TrackerView, opts: { follow?: boolean; mapStatus?: MapStatus } = {}) {
  const onRecenter = vi.fn();
  const utils = render(
    <StatusPanel
      view={view}
      follow={opts.follow ?? true}
      mapStatus={opts.mapStatus ?? 'ready'}
      onRecenter={onRecenter}
    />,
  );
  const rerenderPanel = (next: TrackerView, mapStatus: MapStatus = opts.mapStatus ?? 'ready') =>
    utils.rerender(
      <StatusPanel
        view={next}
        follow={opts.follow ?? true}
        mapStatus={mapStatus}
        onRecenter={onRecenter}
      />,
    );
  return { ...utils, onRecenter, rerenderPanel };
}

const liveRegion = () => screen.getByRole('status');

describe('StatusPanel text alternative', () => {
  it('shows coordinates, UTC time, age, state, connection, provider and trail note', () => {
    renderPanel(previewViews.fresh());
    expect(screen.getByTestId('coordinates')).toHaveTextContent('45.01° N, 18.40° W');
    expect(screen.getByTestId('calculated')).toHaveTextContent('14:01:23 UTC, 11 Oct 2026');
    expect(screen.getByTestId('age')).toHaveTextContent('5 seconds ago');
    expect(screen.getByTestId('data-state')).toHaveTextContent('Fresh');
    expect(screen.getByTestId('connection')).toHaveTextContent('Connected');
    expect(screen.getByRole('link', { name: 'Where the ISS at' })).toHaveAttribute(
      'href',
      'https://wheretheiss.at/',
    );
    expect(screen.getByTestId('trail-note')).toHaveTextContent(
      'Trail: observed during this session.',
    );
  });

  it('waiting state before the first position', () => {
    renderPanel(previewViews.waiting());
    expect(screen.getByTestId('data-state')).toHaveTextContent('Waiting for first position');
    expect(screen.getByTestId('coordinates')).toHaveTextContent('Not available yet');
    expect(screen.queryByTestId('trail-note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Recenter on ISS' })).toBeDisabled();
  });

  it('unverified time shows the absolute provider time instead of an age', () => {
    renderPanel(
      makeView({
        freshness: { state: 'unverified', ageMs: 3_000, clockWarning: 'time-unverified' },
      }),
    );
    expect(screen.getByTestId('data-state')).toHaveTextContent('Time could not be verified');
    expect(screen.getByTestId('calculated')).toHaveTextContent('14:01:23 UTC, 11 Oct 2026');
    expect(screen.getByTestId('age')).not.toHaveTextContent('seconds ago');
  });

  it('offline, retry-wait, blocked and paused connection text', () => {
    const { rerenderPanel } = renderPanel(previewViews.staleOffline());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'Offline. Last position calculated 1 minute ago.',
    );
    rerenderPanel(previewViews.delayed());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'Connection problem, retrying in 18 s',
    );
    rerenderPanel(previewViews.blocked());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'Source unavailable (HTTP 404). Automatic retry stopped.',
    );
    rerenderPanel(previewViews.paused());
    expect(screen.getByTestId('connection')).toHaveTextContent('Paused');
  });

  it('A13: map-unavailable notice for tiles-failing and init-failed, full text still shown', () => {
    const { rerenderPanel } = renderPanel(previewViews.fresh(), { mapStatus: 'tiles-failing' });
    expect(screen.getByTestId('map-unavailable')).toHaveTextContent('Map tiles are not loading');
    expect(screen.getByTestId('coordinates')).toHaveTextContent('45.01° N, 18.40° W');
    rerenderPanel(previewViews.fresh(), 'init-failed');
    expect(screen.getByTestId('map-unavailable')).toHaveTextContent('could not be started');
    rerenderPanel(previewViews.fresh(), 'ready');
    expect(screen.queryByTestId('map-unavailable')).toBeNull();
  });

  it('G1-v2: clock-suspect notice', () => {
    renderPanel(previewViews.clockSuspect());
    expect(screen.getByTestId('clock-suspect')).toHaveTextContent(
      'Your device clock looks wrong, so position times can’t be verified. Check your date and time settings.',
    );
  });
});

describe('A14 controls', () => {
  it('every control has an accessible name', () => {
    renderPanel(previewViews.fresh());
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect(b).toHaveAccessibleName();
  });

  it('Pause/Resume toggle calls the right action', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const actions = { pause, resume, retry: vi.fn() };
    const { rerenderPanel } = renderPanel(makeView({ actions }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause updates' }));
    expect(pause).toHaveBeenCalledTimes(1);
    rerenderPanel(makeView({ actions, snapshot: { transport: 'paused' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume updates' }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('Retry disabled shows the reason and countdown; enabled Retry calls retry()', () => {
    const retry = vi.fn();
    const actions = { pause: vi.fn(), resume: vi.fn(), retry };
    const { rerenderPanel } = renderPanel(
      makeView({
        actions,
        snapshot: { transport: 'retry-wait', retryBlockedBy: 'backoff' },
        secondsUntilEligible: 12,
      }),
    );
    const button = screen.getByRole('button', { name: 'Retry now' });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('retry-reason')).toHaveTextContent(
      'Retry unavailable: Waiting before trying again. Available in 12 s.',
    );
    expect(button).toHaveAccessibleDescription(/Available in 12 s/);
    rerenderPanel(makeView({ actions, snapshot: { transport: 'offline', retryBlockedBy: null } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('retry-reason')).toBeNull();
  });

  it('Recenter calls onRecenter and the follow state is shown', () => {
    const { onRecenter } = renderPanel(makeView(), { follow: false });
    expect(screen.getByTestId('follow-state')).toHaveTextContent('Not following');
    fireEvent.click(screen.getByRole('button', { name: 'Recenter on ISS' }));
    expect(onRecenter).toHaveBeenCalledTimes(1);
  });

  it('shows Following when follow is true', () => {
    renderPanel(makeView(), { follow: true });
    expect(screen.getByTestId('follow-state')).toHaveTextContent('Following');
  });
});

describe('A14 live region', () => {
  it('is polite and starts empty', () => {
    renderPanel(previewViews.fresh());
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion()).toHaveTextContent('');
  });

  it('does not change on age ticks or coordinate updates; changes on stale', () => {
    const { rerenderPanel } = renderPanel(previewViews.waiting());
    rerenderPanel(makeView({ freshness: { ageMs: 1_000 } }));
    expect(liveRegion()).toHaveTextContent('First position received.');

    for (let i = 2; i < 10; i += 1) {
      const sample = previewSample({ latitudeDeg: 45 + i, longitudeDeg: -18 + i });
      rerenderPanel(
        makeView({ snapshot: { anchor: previewAnchor(sample) }, freshness: { ageMs: i * 1_000 } }),
      );
      expect(liveRegion()).toHaveTextContent('First position received.');
    }

    rerenderPanel(makeView({ freshness: { state: 'stale', ageMs: 61_000 } }));
    expect(liveRegion()).toHaveTextContent('Position data is stale.');
    rerenderPanel(makeView({ freshness: { state: 'stale', ageMs: 70_000 } }));
    expect(liveRegion()).toHaveTextContent('Position data is stale.');
  });

  it('announces offline, recovered, blocked, paused and resumed', () => {
    const { rerenderPanel } = renderPanel(makeView());
    rerenderPanel(makeView({ snapshot: { transport: 'offline' } }));
    expect(liveRegion()).toHaveTextContent('Offline.');
    rerenderPanel(makeView());
    expect(liveRegion()).toHaveTextContent('Connection recovered.');
    rerenderPanel(makeView({ snapshot: { transport: 'paused' } }));
    expect(liveRegion()).toHaveTextContent('Updates paused.');
    rerenderPanel(makeView());
    expect(liveRegion()).toHaveTextContent('Updates resumed.');
    rerenderPanel(makeView({ snapshot: { transport: 'blocked' } }));
    expect(liveRegion()).toHaveTextContent('Source unavailable. Automatic retry stopped.');
  });

  it('retry countdown ticking does not change the live region', () => {
    const { rerenderPanel } = renderPanel(previewViews.delayed());
    const before = liveRegion().textContent;
    rerenderPanel(makeView({ ...previewViews.delayed(), secondsUntilEligible: 17 }));
    expect(liveRegion().textContent).toBe(before);
  });
});

describe('TrackerLayout', () => {
  it('renders header, map and status slots in landmarks', () => {
    render(<TrackerLayout header={<h1>ISS Live Tracker</h1>} map={<p>map</p>} status={<p>s</p>} />);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'ISS Live Tracker' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText('map')).toBeInTheDocument();
  });
});
