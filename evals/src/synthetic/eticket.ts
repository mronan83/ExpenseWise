import type { Random } from '../random.ts';
import { dollars, escapeHtml, percentOf, printedDate } from './money.ts';
import { CARD_BRANDS, type SyntheticDocument } from './types.ts';

const AIRLINES = ['Northstar Air', 'Pacific Crest Airlines', 'Bluebird Airways', 'Meridian Air'];
const AIRPORTS = ['ORD', 'DEN', 'AUS', 'SEA', 'BOS', 'SFO', 'ATL', 'JFK', 'LAX', 'MSP'];
const PASSENGERS = ['MORGAN/ALEX', 'LEE/JORDAN', 'CHEN/RILEY', 'PATEL/SAM'];

/** US taxes on a domestic ticket: 7.5% excise plus per-segment fees, in cents. */
const SEGMENT_FEES = [
  ['September 11th Security Fee', 560],
  ['U.S. Flight Segment Tax', 520],
  ['Passenger Facility Charge', 450],
] as const;

export function eTicket(random: Random): SyntheticDocument {
  const airline = random.pick(AIRLINES);
  const from = random.pick(AIRPORTS);
  const to = random.pick(AIRPORTS.filter((a) => a !== from));
  const segments = random.chance(0.6) ? 2 : 1;
  const base = random.int(89, 689) * 100 + random.pick([0, 0, 40, 60]);
  const issued = `2026-${String(random.int(5, 9)).padStart(2, '0')}-${String(random.int(1, 28)).padStart(2, '0')}`;
  const style = random.pick(['dmy', 'us'] as const);

  const taxes: [string, number][] = [['U.S. Transportation Tax', percentOf(base, 750)]];
  for (const [label, cents] of SEGMENT_FEES) taxes.push([label, cents * segments]);
  const taxTotal = taxes.reduce((s, [, c]) => s + c, 0);
  const total = base + taxTotal;
  const card = String(random.int(1000, 9999));
  const brand = random.pick(CARD_BRANDS);
  const record = Array.from({ length: 6 }, () =>
    random.pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789']),
  ).join('');
  const ticket = `${random.int(100, 999)}${random.int(1_000_000_000, 9_999_999_999)}`;

  const flights = [[from, to], ...(segments === 2 ? [[to, from]] : [])]
    .map(
      ([a, b], i) =>
        `<tr><td>${airline.split(' ')[0]?.slice(0, 2).toUpperCase()} ${random.int(100, 2999)}</td><td>${a} → ${b}</td><td>${i === 0 ? 'Outbound' : 'Return'}</td><td>Main Cabin</td></tr>`,
    )
    .join('');
  const taxRows = taxes
    .map(([label, c]) => `<tr><td>${escapeHtml(label)}</td><td class="r">$${dollars(c)}</td></tr>`)
    .join('');

  const html = `<!doctype html><html><head><style>
    body { font-family: Helvetica, Arial, sans-serif; color: #1b1f24; margin: 40px; font-size: 13px; }
    .bar { background: #12355b; color: #fff; padding: 14px 18px; font-size: 20px; font-weight: bold; }
    h2 { font-size: 15px; margin: 22px 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 6px 4px; border-bottom: 1px solid #e3e6ea; text-align: left; }
    .r { text-align: right; }
    .total td { font-weight: bold; border-top: 2px solid #12355b; }
  </style></head><body>
    <div class="bar">${escapeHtml(airline)}</div>
    <p>Receipt and itinerary · Confirmation code <b>${record}</b> · Issued ${printedDate(issued, style)}</p>
    <p>Passenger: ${random.pick(PASSENGERS)} · Ticket number ${ticket}</p>
    <h2>Flights</h2><table><tbody>${flights}</tbody></table>
    <h2>Fare summary</h2><table><tbody>
      <tr><td>Base fare</td><td class="r">$${dollars(base)}</td></tr>
      ${taxRows}
      <tr class="total"><td>Total</td><td class="r">$${dollars(total)} USD</td></tr>
    </tbody></table>
    <h2>Payment</h2><p>${brand} ending in ${card} · $${dollars(total)}</p>
  </body></html>`;

  return {
    truth: {
      documentType: 'airline_ticket',
      currency: 'USD',
      merchant: airline,
      date: issued,
      subtotal: dollars(base),
      taxTotal: dollars(taxTotal),
      total: dollars(total),
      cardLastFour: card,
    },
    html,
    format: random.chance(0.2) ? 'photo' : 'pdf',
  };
}
