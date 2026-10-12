import type { ReactNode } from 'react';

export const SUMMARY_ID = 'iss-summary';
export const ABOUT_ID = 'about-this-data';

export interface TrackerLayoutProps {
  /** Position summary (or the Replay panel). The complete text alternative to the map. */
  readonly summary: ReactNode;
  /** The <IssMap /> element. Gets a stable height so nothing jumps. */
  readonly map: ReactNode;
  /** One quiet action row below the map. */
  readonly actions?: ReactNode;
  /** Source credit and trail legend, always visible. */
  readonly provenance?: ReactNode;
  /** The "About this data" disclosure body. */
  readonly about?: ReactNode;
  /** The single polite live region, kept outside anything that unmounts. */
  readonly liveRegion?: ReactNode;
}

/** Opens the About disclosure and moves focus to it (a closed <details> ignores #fragments). */
function openAbout(event: { preventDefault: () => void }) {
  const details = document.getElementById(ABOUT_ID);
  if (!(details instanceof HTMLDetailsElement)) return;
  event.preventDefault();
  details.open = true;
  details.querySelector('summary')?.focus();
  details.scrollIntoView({ block: 'nearest' });
}

/** Map-first shell: header, summary, map, actions, provenance, About. Same DOM order everywhere. */
export function TrackerLayout({
  summary,
  map,
  actions,
  provenance,
  about,
  liveRegion,
}: TrackerLayoutProps) {
  return (
    <div className="tracker-layout">
      <a className="skip-link" href={`#${SUMMARY_ID}`}>
        Skip to position
      </a>
      <header className="tracker-header">
        <p className="wordmark">
          <span className="wordmark__iss">ISS</span>{' '}
          <span className="wordmark__name">Live Tracker</span>
        </p>
        {about !== undefined && (
          <a className="tracker-header__about" href={`#${ABOUT_ID}`} onClick={openAbout}>
            About this data
          </a>
        )}
      </header>
      <main className="tracker-main">
        <div className="tracker-title">
          <h1>International Space Station</h1>
          <p>Latest calculated position</p>
        </div>
        <div id={SUMMARY_ID} className="tracker-summary" tabIndex={-1}>
          {summary}
        </div>
        <div className="tracker-map">{map}</div>
        {actions}
        {provenance}
      </main>
      {about !== undefined && (
        <footer className="tracker-footer">
          <details id={ABOUT_ID}>
            <summary>About this data and privacy</summary>
            {about}
          </details>
        </footer>
      )}
      {liveRegion}
    </div>
  );
}
