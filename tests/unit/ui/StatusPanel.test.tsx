import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Controls } from '../../../src/features/status/Controls';
import { StatusPanel } from '../../../src/features/status/StatusPanel';
import { TrackerLayout } from '../../../src/features/status/TrackerLayout';
import { useStatusAnnouncement } from '../../../src/features/status/useStatusAnnouncement';
import {
  makeView,
  previewAnchor,
  previewSample,
  previewViews,
} from '../../../src/features/status/fixtures';
import type { MapStatus, TrackerView } from '../../../src/domain/position';

function renderPanel(view: TrackerView, opts: { mapStatus?: MapStatus } = {}) {
  const utils = render(<StatusPanel view={view} mapStatus={opts.mapStatus ?? 'ready'} />);
  const rerenderPanel = (next: TrackerView, mapStatus: MapStatus = opts.mapStatus ?? 'ready') =>
    utils.rerender(<StatusPanel view={next} mapStatus={mapStatus} />);
  return { ...utils, rerenderPanel };
}

function renderControls(view: TrackerView, opts: { follow?: boolean } = {}) {
  const onRecenter = vi.fn();
  const element = (v: TrackerView) => (
    <Controls view={v} follow={opts.follow ?? true} onRecenter={onRecenter} />
  );
  const utils = render(element(view));
  const rerenderControls = (next: TrackerView) => utils.rerender(element(next));
  return { ...utils, onRecenter, rerenderControls };
}

/** Tiny harness: renders the announcer hook's text in a polite role=status element. */
function AnnouncerHarness({ view }: { view: TrackerView }): ReactNode {
  const text = useStatusAnnouncement(view);
  return (
    <p role="status" aria-live="polite" aria-atomic="true">
      {text}
    </p>
  );
}

function renderAnnouncer(view: TrackerView) {
  const utils = render(<AnnouncerHarness view={view} />);
  const rerenderView = (next: TrackerView) => utils.rerender(<AnnouncerHarness view={next} />);
  return { ...utils, rerenderView };
}

const liveRegion = () => screen.getByRole('status');

describe('StatusPanel text alternative', () => {
  it('shows coordinates, UTC time, age, calculation state and updates state', () => {
    renderPanel(previewViews.fresh());
    expect(screen.getByTestId('coordinates')).toHaveTextContent('45.01° N, 18.40° W');
    expect(screen.getByTestId('calculated')).toHaveTextContent('14:01:23 UTC, 11 Oct 2026');
    expect(screen.getByTestId('age')).toHaveTextContent('5 seconds ago');
    expect(screen.getByTestId('data-state')).toHaveTextContent('Fresh');
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Running');
    // Healthy polling with a position needs no connection notice.
    expect(screen.queryByTestId('connection')).toBeNull();
  });

  it('waiting state before the first position', () => {
    renderPanel(previewViews.waiting());
    expect(screen.getByTestId('data-state')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('coordinates')).toHaveTextContent('Not available yet');
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Connecting');
    expect(screen.getByTestId('connection')).toHaveTextContent('Waiting for the first position.');
    expect(screen.queryByTestId('calculated')).toBeNull();
  });

  it('unverified time shows the absolute provider time instead of an age', () => {
    renderPanel(
      makeView({
        freshness: { state: 'unverified', ageMs: 3_000, clockWarning: 'time-unverified' },
      }),
    );
    expect(screen.getByTestId('data-state')).toHaveTextContent('Time could not be verified');
    expect(screen.getByTestId('calculated')).toHaveTextContent('14:01:23 UTC, 11 Oct 2026');
    expect(screen.getByTestId('age')).toHaveTextContent('Age unknown');
    expect(screen.getByTestId('age')).not.toHaveTextContent('seconds ago');
  });

  it('offline, retry-wait, blocked and paused connection text', () => {
    const { rerenderPanel } = renderPanel(previewViews.staleOffline());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'You appear to be offline. Last position calculated 1 minute ago.',
    );
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Offline');
    rerenderPanel(previewViews.delayed());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'Source unavailable. Next attempt in 18 seconds.',
    );
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Retrying');
    rerenderPanel(previewViews.blocked());
    expect(screen.getByTestId('connection')).toHaveTextContent(
      'Source unavailable (HTTP 404). Automatic updates stopped.',
    );
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Stopped');
    rerenderPanel(previewViews.paused());
    expect(screen.getByTestId('connection')).toHaveTextContent('Updates paused.');
    expect(screen.getByTestId('updates-state')).toHaveTextContent('Paused');
  });

  it('A13: map-unavailable notice for tiles-failing and init-failed, full text still shown', () => {
    const { rerenderPanel } = renderPanel(previewViews.fresh(), { mapStatus: 'tiles-failing' });
    expect(screen.getByTestId('map-unavailable')).toHaveTextContent(
      'Map unavailable: map images are not loading',
    );
    expect(screen.getByTestId('coordinates')).toHaveTextContent('45.01° N, 18.40° W');
    rerenderPanel(previewViews.fresh(), 'init-failed');
    expect(screen.getByTestId('map-unavailable')).toHaveTextContent(
      'Map unavailable: it could not be started',
    );
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
  const renderWithReplay = (view: TrackerView, follow = true) => {
    const onRecenter = vi.fn();
    const onEnterReplay = vi.fn();
    const utils = render(
      <Controls
        view={view}
        follow={follow}
        onRecenter={onRecenter}
        replayAvailable
        onEnterReplay={onEnterReplay}
      />,
    );
    return { ...utils, onRecenter, onEnterReplay };
  };

  it('every control has an accessible name', () => {
    renderWithReplay(previewViews.fresh());
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect(b).toHaveAccessibleName();
    expect(screen.getByRole('button', { name: 'Replay' })).toBeEnabled();
  });

  it('Recenter is disabled with a hint before the first position', () => {
    renderControls(previewViews.waiting());
    expect(screen.getByRole('button', { name: 'Recenter on ISS' })).toBeDisabled();
    expect(screen.getByTestId('recenter-hint')).toBeInTheDocument();
  });

  it('Pause/Resume toggle calls the right action', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const actions = { pause, resume, retry: vi.fn() };
    const { rerenderControls } = renderControls(makeView({ actions }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause updates' }));
    expect(pause).toHaveBeenCalledTimes(1);
    rerenderControls(makeView({ actions, snapshot: { transport: 'paused' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume updates' }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('Retry is only offered when relevant', () => {
    const { rerenderControls } = renderControls(makeView());
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
    for (const transport of ['paused', 'hidden', 'polling'] as const) {
      rerenderControls(makeView({ snapshot: { transport } }));
      expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
      expect(screen.queryByTestId('retry-reason')).toBeNull();
    }
    for (const transport of ['retry-wait', 'offline', 'blocked'] as const) {
      rerenderControls(makeView({ snapshot: { transport } }));
      expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    }
  });

  it('Retry disabled shows the reason and countdown; enabled Retry calls retry()', () => {
    const retry = vi.fn();
    const actions = { pause: vi.fn(), resume: vi.fn(), retry };
    const { rerenderControls } = renderControls(
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
    rerenderControls(
      makeView({ actions, snapshot: { transport: 'offline', retryBlockedBy: null } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('retry-reason')).toBeNull();
  });

  it('Recenter calls onRecenter, and is the primary action only while exploring', () => {
    const { onRecenter, unmount } = renderWithReplay(makeView(), false);
    const recenter = screen.getByRole('button', { name: 'Recenter on ISS' });
    expect(recenter).toHaveClass('button--primary');
    fireEvent.click(recenter);
    expect(onRecenter).toHaveBeenCalledTimes(1);
    unmount();
    renderWithReplay(makeView(), true);
    expect(screen.getByRole('button', { name: 'Recenter on ISS' })).not.toHaveClass(
      'button--primary',
    );
  });

  it('Replay button calls onEnterReplay', () => {
    const { onEnterReplay } = renderWithReplay(makeView());
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(onEnterReplay).toHaveBeenCalledTimes(1);
  });
});

describe('A14 live region (useStatusAnnouncement)', () => {
  it('is polite and starts empty', () => {
    renderAnnouncer(previewViews.fresh());
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion()).toHaveTextContent('');
  });

  it('does not change on age ticks or coordinate updates; changes on stale', () => {
    const { rerenderView } = renderAnnouncer(previewViews.waiting());
    rerenderView(makeView({ freshness: { ageMs: 1_000 } }));
    expect(liveRegion()).toHaveTextContent('First position received.');

    for (let i = 2; i < 10; i += 1) {
      const sample = previewSample({ latitudeDeg: 45 + i, longitudeDeg: -18 + i });
      rerenderView(
        makeView({ snapshot: { anchor: previewAnchor(sample) }, freshness: { ageMs: i * 1_000 } }),
      );
      expect(liveRegion()).toHaveTextContent('First position received.');
    }

    rerenderView(makeView({ freshness: { state: 'stale', ageMs: 61_000 } }));
    expect(liveRegion()).toHaveTextContent('Position data is stale.');
    rerenderView(makeView({ freshness: { state: 'stale', ageMs: 70_000 } }));
    expect(liveRegion()).toHaveTextContent('Position data is stale.');
  });

  it('announces offline, recovered, blocked, paused and resumed', () => {
    const { rerenderView } = renderAnnouncer(makeView());
    rerenderView(makeView({ snapshot: { transport: 'offline' } }));
    expect(liveRegion()).toHaveTextContent('Offline.');
    rerenderView(makeView());
    expect(liveRegion()).toHaveTextContent('Connection recovered.');
    rerenderView(makeView({ snapshot: { transport: 'paused' } }));
    expect(liveRegion()).toHaveTextContent('Updates paused.');
    rerenderView(makeView());
    expect(liveRegion()).toHaveTextContent('Updates resumed.');
    rerenderView(makeView({ snapshot: { transport: 'blocked' } }));
    expect(liveRegion()).toHaveTextContent('Source unavailable. Automatic retry stopped.');
  });

  it('retry countdown ticking does not change the live region', () => {
    const { rerenderView } = renderAnnouncer(previewViews.delayed());
    const before = liveRegion().textContent;
    rerenderView(makeView({ ...previewViews.delayed(), secondsUntilEligible: 17 }));
    expect(liveRegion().textContent).toBe(before);
  });
});

describe('TrackerLayout', () => {
  it('renders skip link, header, title, map, summary, actions and provenance in landmarks', () => {
    render(
      <TrackerLayout
        summary={<p>s</p>}
        map={<p>map</p>}
        actions={<p>actions</p>}
        provenance={<p>prov</p>}
        about={<p>about body</p>}
        liveRegion={<p role="status">live</p>}
      />,
    );
    expect(screen.getByRole('link', { name: 'Skip to position' })).toHaveAttribute(
      'href',
      '#iss-summary',
    );
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Live Tracker')).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'About this data' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(
      within(main).getByRole('heading', { level: 1, name: 'International Space Station' }),
    ).toBeInTheDocument();
    for (const t of ['map', 's', 'actions', 'prov']) {
      expect(within(main).getByText(t)).toBeInTheDocument();
    }
    expect(
      within(screen.getByRole('contentinfo')).getByText('About this data and privacy'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('live');
  });

  it('omits the About link and footer when no about content is given', () => {
    render(<TrackerLayout summary={<p>s</p>} map={<p>map</p>} />);
    expect(screen.queryByRole('link', { name: 'About this data' })).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});
