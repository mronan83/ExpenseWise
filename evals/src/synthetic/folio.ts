import type { Random } from '../random.ts';
import { addDays, dollars, escapeHtml, percentOf, printedDate } from './money.ts';
import { CARD_BRANDS, type SyntheticDocument } from './types.ts';

const HOTELS = [
  'Harborline Suites',
  'Cedar & Stone Hotel',
  'The Larkspur',
  'Meridian Point Inn',
  'Northgate Grand Hotel',
  'Bluewater Lodge',
  'The Alder House',
  'Summit Row Hotel',
];

/** Fictional cities' lodging taxes, in basis points. */
const CITIES = [
  {
    city: 'Chicago, IL 60601',
    taxes: [
      ['State hotel tax', 600],
      ['City hotel tax', 1139],
    ],
  },
  {
    city: 'Denver, CO 80202',
    taxes: [
      ['Lodging tax', 1075],
      ['Tourism fee', 100],
    ],
  },
  {
    city: 'Austin, TX 78701',
    taxes: [
      ['State occupancy tax', 600],
      ['City occupancy tax', 900],
    ],
  },
  {
    city: 'Seattle, WA 98101',
    taxes: [
      ['Sales tax', 1035],
      ['Convention center tax', 700],
    ],
  },
  {
    city: 'Boston, MA 02110',
    taxes: [
      ['State room occupancy', 570],
      ['Local occupancy', 650],
    ],
  },
] as const;

const GUESTS = ['Alex Morgan', 'Jordan Lee', 'Riley Chen', 'Sam Patel', 'Casey Brooks'];

export function hotelFolio(random: Random): SyntheticDocument {
  const hotel = random.pick(HOTELS);
  const place = random.pick(CITIES);
  const nights = random.int(1, 4);
  const rate = random.int(129, 349) * 100 + random.pick([0, 0, 0, 99, 50]);
  const arrival = `2026-${String(random.int(6, 9)).padStart(2, '0')}-${String(random.int(1, 26)).padStart(2, '0')}`;
  const departure = addDays(arrival, nights);
  const style = random.pick(['dmy', 'us'] as const);

  type Line = { date: string; text: string; cents: number; tax: boolean };
  const lines: Line[] = [];
  for (let n = 0; n < nights; n++) {
    const day = addDays(arrival, n);
    lines.push({ date: day, text: 'Room charge', cents: rate, tax: false });
    for (const [label, bp] of place.taxes) {
      lines.push({ date: day, text: label, cents: percentOf(rate, bp), tax: true });
    }
    if (random.chance(0.3)) {
      lines.push({ date: day, text: 'Restaurant', cents: random.int(1800, 7600), tax: false });
    }
  }
  if (random.chance(0.5)) {
    lines.push({
      date: departure,
      text: 'Valet parking',
      cents: random.int(35, 65) * 100 * nights,
      tax: false,
    });
  }
  const total = lines.reduce((s, l) => s + l.cents, 0);
  const taxes = lines.filter((l) => l.tax).reduce((s, l) => s + l.cents, 0);
  const printSubtotal = random.chance(0.5);
  const card = String(random.int(1000, 9999));
  const brand = random.pick(CARD_BRANDS);
  const confirmation = String(random.int(10_000_000, 99_999_999));

  const rows = lines
    .map(
      (l) =>
        `<tr><td>${printedDate(l.date, style)}</td><td>${escapeHtml(l.text)}</td><td class="r">${dollars(l.cents)}</td><td></td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><head><style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #222; margin: 48px; font-size: 13px; }
    h1 { font-size: 22px; margin: 0; letter-spacing: 0.04em; }
    .addr { color: #555; margin-bottom: 24px; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 5px 6px; border-bottom: 1px solid #ddd; text-align: left; }
    .r { text-align: right; }
    .sum td { border: 0; font-weight: bold; }
  </style></head><body>
    <h1>${escapeHtml(hotel.toUpperCase())}</h1>
    <div class="addr">${random.int(100, 999)} Lakeshore Avenue · ${place.city}</div>
    <h2 style="font-size:15px">Guest Folio</h2>
    <div class="meta">
      <div>Guest: ${GUESTS[random.int(0, GUESTS.length - 1)]}</div><div>Confirmation: ${confirmation}</div>
      <div>Arrival: ${printedDate(arrival, style)}</div><div>Departure: ${printedDate(departure, style)}</div>
      <div>Room: ${random.int(201, 1890)}</div><div>Rate: ${dollars(rate)} USD</div>
    </div>
    <table><thead><tr><th>Date</th><th>Description</th><th class="r">Charges</th><th class="r">Credits</th></tr></thead>
    <tbody>${rows}
      <tr><td>${printedDate(departure, style)}</td><td>${brand} XXXXXXXXXXXX${card}</td><td></td><td class="r">${dollars(total)}</td></tr>
    </tbody></table>
    <table style="margin-top:14px"><tbody class="sum">
      ${printSubtotal ? `<tr><td>Subtotal (before taxes)</td><td class="r">${dollars(total - taxes)}</td></tr>` : ''}
      <tr><td>Total taxes</td><td class="r">${dollars(taxes)}</td></tr>
      <tr><td>Total charges</td><td class="r">${dollars(total)} USD</td></tr>
      <tr><td>Balance due</td><td class="r">0.00</td></tr>
    </tbody></table>
  </body></html>`;

  return {
    truth: {
      documentType: 'hotel_folio',
      currency: 'USD',
      merchant: hotel,
      date: departure,
      total: dollars(total),
      taxTotal: dollars(taxes),
      ...(printSubtotal ? { subtotal: dollars(total - taxes) } : {}),
      cardLastFour: card,
      city: place.city.split(',')[0]!,
      country: 'US',
    },
    html,
    format: random.chance(0.25) ? 'photo' : 'pdf',
  };
}
