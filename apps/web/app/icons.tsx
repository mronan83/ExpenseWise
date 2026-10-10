/**
 * The tab bar's icons (docs/brand.md): drawn on a 24-point grid with a 1.75 stroke, round caps
 * and joins, like the mark. Each sits beside its label, so it is hidden from screen readers.
 */
import type { ReactNode } from 'react';

function Icon({ children, strokeWidth = 1.75 }: { children: ReactNode; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** An inbox tray: Home is the Needs you inbox. */
export const HomeIcon = () => (
  <Icon>
    <path d="M4 13.5 6.5 6h11l2.5 7.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
    <path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" />
  </Icon>
);

/** A receipt with its torn edge, as in the mark. */
export const ExpensesIcon = () => (
  <Icon>
    <path d="M7 3.5h10v17l-2.5-1.6-2.5 1.6-2.5-1.6L7 20.5z" />
    <path d="M9.5 8h5M9.5 11.5h5M9.5 15h3" />
  </Icon>
);

/** A suitcase. */
export const TripsIcon = () => (
  <Icon>
    <rect x="4" y="8" width="16" height="11.5" rx="2" />
    <path d="M9 8V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M9 8v11.5M15 8v11.5" />
  </Icon>
);

/** A page with its corner turned and a tick: a report, ready. */
export const ReportsIcon = () => (
  <Icon>
    <path d="M6.5 3.5H15l3.5 3.5v12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
    <path d="M15 3.5V7h3.5M8.8 14.2l2.1 2.1 4.3-4.6" />
  </Icon>
);

/** Capture: a plus, heavier so it holds on the filled button. */
export const CaptureIcon = () => (
  <Icon strokeWidth={2.2}>
    <path d="M12 6v12M6 12h12" />
  </Icon>
);

/** A camera: take a photo of a receipt (FR-CAP-12). */
export const CameraIcon = () => (
  <Icon>
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
    <circle cx="12" cy="12.75" r="3.25" />
  </Icon>
);

/** An arrow up out of a tray: upload a file. */
export const UploadIcon = () => (
  <Icon>
    <path d="M12 15V4.5M8 8.5l4-4 4 4" />
    <path d="M4.5 14.5V18a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3.5" />
  </Icon>
);

/** A road's two edges and its centre line: a drive. */
export const DriveIcon = () => (
  <Icon>
    <path d="M8.5 4 5 20M15.5 4 19 20M12 5v2.5M12 11v2.5M12 17v2.5" />
  </Icon>
);

/** A card with its stripe: a card statement. */
export const CardIcon = () => (
  <Icon>
    <rect x="3.5" y="6" width="17" height="12" rx="2" />
    <path d="M3.5 10h17M7 14.5h3.5" />
  </Icon>
);

/** Rows of a list: a downloaded transaction list. */
export const ListIcon = () => (
  <Icon>
    <path d="M9 7h11M9 12h11M9 17h11" />
    <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" strokeWidth={2.4} />
  </Icon>
);
