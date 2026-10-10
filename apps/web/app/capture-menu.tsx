'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ApiProblem } from '../lib/api';
import { bringInList, bringInStatement, CARD_STATEMENTS_FLAG } from '../lib/card-statements';
import { loadFeatures } from '../lib/features';
import { MILEAGE_FLAG } from '../lib/mileage';
import { ReceiptFileError } from '../lib/receipt-file';
import { captureReceipt } from '../lib/receipts';
import { CameraIcon, CaptureIcon, CardIcon, DriveIcon, ListIcon, UploadIcon } from './icons';

/** The receipts address, where it is configured, for forwarding receipts by email. */
const RECEIPTS_ADDRESS = process.env.NEXT_PUBLIC_RECEIPTS_ADDRESS?.trim() || null;

const describeError = (error: unknown) =>
  error instanceof ReceiptFileError
    ? error.message
    : error instanceof ApiProblem
      ? [error.message, error.detail].filter(Boolean).join('. ')
      : error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';

const choice =
  'flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-base font-medium hover:bg-carbon-wash focus-within:bg-carbon-wash';

/**
 * Capture, in the middle of the tab bar: every way to bring something in, from one place
 * (FR-CAP-12, US-CAP-10). A photo of a receipt is first and is still two taps from any screen;
 * a drive, a statement or a list is offered only while its feature is on, so the features are
 * read when the menu opens rather than on every page.
 */
export function CaptureMenu({ current }: { current: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState(false);
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The dialog is modal while shown: the browser keeps focus inside it, closes it on Escape and
  // hands focus back to Capture.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (shown && !el.open) el.showModal();
    if (!shown && el.open) el.close();
  }, [shown]);

  function open() {
    setProblem(null);
    setProgress(null);
    setShown(true);
    void loadFeatures().then(({ features }) =>
      setOn(new Set(features.filter((f) => f.enabled).map((f) => f.key))),
    );
  }
  const close = () => setShown(false);

  /** Runs one way in, then goes where its result is shown. */
  const bring =
    (work: (file: File) => Promise<string>) => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file) return;
      setProblem(null);
      void (async () => {
        try {
          const next = await work(file);
          close();
          router.push(next);
        } catch (error) {
          setProblem(describeError(error));
          setProgress(null);
        }
      })();
    };
  const receipt = (source: 'camera' | 'upload') =>
    bring(async (file) => `/receipts/${(await captureReceipt(file, source, setProgress)).id}`);
  const statement = bring(async (file) => {
    await bringInStatement(file, setProgress);
    return '/card';
  });
  const list = bring(async (file) => {
    setProgress('Reading the list…');
    await bringInList(file);
    return '/card';
  });
  const busy = progress !== null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-current={current ? 'page' : undefined}
        className="grid size-11 place-items-center rounded-full bg-carbon text-carbon-ink"
      >
        <CaptureIcon />
        <span className="sr-only">Capture</span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="capture-menu-title"
        onClose={close}
        onClick={(event) => {
          // A tap on the backdrop, outside the sheet, closes it.
          if (event.target === event.currentTarget) close();
        }}
        className="mx-auto mt-auto mb-0 w-full max-w-md rounded-t-2xl border border-rule bg-sheet p-0 text-ink backdrop:bg-ink/40"
      >
        <div className="flex flex-col gap-1 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-left">
          <div className="flex items-center justify-between pb-1">
            <h2 id="capture-menu-title" className="text-lg font-semibold">
              Bring something in
            </h2>
            <button
              type="button"
              onClick={close}
              className="tap min-h-11 px-2 text-sm font-semibold text-carbon"
            >
              Close
            </button>
          </div>
          <ul className="flex flex-col">
            <FileChoice
              icon={<CameraIcon />}
              label="Take a photo of a receipt"
              accept="image/*"
              capture
              disabled={busy}
              onChange={receipt('camera')}
            />
            <FileChoice
              icon={<UploadIcon />}
              label="Upload a receipt"
              hint="A photo or a PDF"
              accept="image/*,application/pdf"
              disabled={busy}
              onChange={receipt('upload')}
            />
            {on.has(MILEAGE_FLAG) ? (
              <li>
                <Link href="/mileage/new" onClick={close} className={choice}>
                  <span className="text-carbon">
                    <DriveIcon />
                  </span>
                  <span>Add a drive</span>
                </Link>
              </li>
            ) : null}
            {on.has(CARD_STATEMENTS_FLAG) ? (
              <>
                <FileChoice
                  icon={<CardIcon />}
                  label="Bring in a card statement"
                  hint="Its PDF"
                  accept="application/pdf,.pdf"
                  disabled={busy}
                  onChange={statement}
                />
                <FileChoice
                  icon={<ListIcon />}
                  label="Bring in a downloaded list"
                  hint="A CSV from your card’s site, read at no cost"
                  accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
                  disabled={busy}
                  onChange={list}
                />
              </>
            ) : null}
          </ul>
          <p role="status" className="min-h-5 px-3 text-sm text-ink-2">
            {progress}
          </p>
          {problem ? (
            <p role="alert" className="px-3 text-sm text-warn">
              {problem}
            </p>
          ) : null}
          <p className="px-3 text-sm text-ink-2">
            Or forward a receipt by email to{' '}
            {RECEIPTS_ADDRESS ? (
              <span className="font-semibold text-ink">{RECEIPTS_ADDRESS}</span>
            ) : (
              'your receipts address'
            )}
            .
          </p>
          <Link
            href="/receipts"
            onClick={close}
            className="tap min-h-11 self-start px-3 py-2 text-sm font-semibold text-carbon"
          >
            See all receipts
          </Link>
        </div>
      </dialog>
    </>
  );
}

/**
 * A way in that picks a file, its icon and words a 48-point row: the row is the control, so one
 * tap opens the picker or the camera.
 */
function FileChoice({
  icon,
  label,
  hint,
  accept,
  capture,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  accept: string;
  capture?: boolean;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <li>
      <label className={`${choice} ${disabled ? 'pointer-events-none opacity-60' : ''}`}>
        <span className="text-carbon">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{label}</span>
          {hint ? <span className="text-sm font-normal text-ink-2">{hint}</span> : null}
        </span>
        <input
          type="file"
          accept={accept}
          {...(capture ? { capture: 'environment' as const } : {})}
          className="sr-only"
          disabled={disabled}
          onChange={onChange}
        />
      </label>
    </li>
  );
}
