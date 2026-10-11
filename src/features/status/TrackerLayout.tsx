import type { ReactNode } from 'react';

export interface TrackerLayoutProps {
  /** Usually an <h1> plus a one-line description. Rendered inside <header>. */
  readonly header: ReactNode;
  /** The <IssMap /> element. Gets a stable height so nothing jumps. */
  readonly map: ReactNode;
  /** The <StatusPanel /> element. Beside the map at >= 900 px, below it on narrow screens. */
  readonly status: ReactNode;
}

export function TrackerLayout({ header, map, status }: TrackerLayoutProps) {
  return (
    <div className="tracker-layout">
      <header className="tracker-header">{header}</header>
      <main className="tracker-main">
        <div className="tracker-map">{map}</div>
        <div className="tracker-status">{status}</div>
      </main>
    </div>
  );
}
