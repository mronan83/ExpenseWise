import type { TripSummary } from '../../lib/trips';

/** The fields of a trip, for making or editing one. */
export function TripFields({ trip }: { trip?: TripSummary }) {
  const field =
    'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  return (
    <>
      <label className={label}>
        Name
        <input
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={trip?.name}
          placeholder="Houston · Acme onsite"
          className={field}
        />
      </label>
      <label className={label}>
        Purpose
        <input
          name="purpose"
          maxLength={500}
          autoComplete="off"
          defaultValue={trip?.purpose ?? ''}
          placeholder="Client onsite"
          className={field}
        />
      </label>
      <label className={label}>
        Where
        <input
          name="primaryCity"
          maxLength={120}
          autoComplete="off"
          defaultValue={trip?.primaryCity ?? ''}
          placeholder="Houston"
          className={field}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          First day
          <input
            name="startDate"
            type="date"
            required
            defaultValue={trip?.startDate}
            className={field}
          />
        </label>
        <label className={label}>
          Last day
          <input
            name="endDate"
            type="date"
            required
            defaultValue={trip?.endDate}
            className={field}
          />
        </label>
      </div>
    </>
  );
}
