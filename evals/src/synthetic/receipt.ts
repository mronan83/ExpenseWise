import type { Random } from '../random.ts';
import { dollars, escapeHtml, percentOf, printedDate } from './money.ts';
import { CARD_BRANDS, type SyntheticDocument } from './types.ts';

const RESTAURANTS = [
  'Bayside Grill',
  'Copper Kettle Diner',
  'Little Saigon Kitchen',
  'Juniper & Rye',
  'Oak Street Tacos',
  'The Gilded Fork',
];
const DISHES = [
  ['Club sandwich', 1450],
  ['Pho tai', 1595],
  ['Caesar salad', 1200],
  ['Fish tacos', 1375],
  ['Ribeye', 3800],
  ['Iced tea', 395],
  ['Sparkling water', 450],
  ['Espresso', 375],
  ['Burger & fries', 1695],
  ['Soup of the day', 795],
] as const;

/** A US restaurant card slip with a handwritten-style tip, rendered as a phone photo. */
export function restaurantReceipt(random: Random): SyntheticDocument {
  const name = random.pick(RESTAURANTS);
  const count = random.int(2, 6);
  const items = Array.from({ length: count }, () => random.pick(DISHES));
  const subtotal = items.reduce((s, [, c]) => s + c, 0);
  const taxBp = random.pick([600, 725, 825, 875, 1025]);
  const tax = percentOf(subtotal, taxBp);
  const tip = percentOf(subtotal, random.pick([1500, 1800, 2000, 2200]));
  const total = subtotal + tax + tip;
  const date = `2026-${String(random.int(6, 9)).padStart(2, '0')}-${String(random.int(1, 28)).padStart(2, '0')}`;
  const card = String(random.int(1000, 9999));
  const brand = random.pick(CARD_BRANDS);

  const rows = items
    .map(
      ([d, c]) => `<div class="row"><span>${escapeHtml(d)}</span><span>${dollars(c)}</span></div>`,
    )
    .join('');
  const html = `<!doctype html><html><head><style>
    body { margin: 0; background: #8a8f87; display: flex; justify-content: center; padding: 40px 0; }
    .slip { width: 300px; background: #fbfaf5; padding: 22px 20px; font-family: 'Courier New', monospace;
            font-size: 13px; color: #2b2b2b; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
    .c { text-align: center; } .row { display: flex; justify-content: space-between; }
    .hr { border-top: 1px dashed #777; margin: 8px 0; }
    .hand { font-family: 'Comic Sans MS', cursive; color: #1b3a8a; font-size: 16px; }
  </style></head><body><div class="slip">
    <div class="c"><b>${escapeHtml(name.toUpperCase())}</b><br>${random.int(10, 899)} Main St<br>Tel (555) ${random.int(200, 899)}-${random.int(1000, 9999)}</div>
    <div class="hr"></div>
    <div class="row"><span>${printedDate(date, 'us')}</span><span>${random.int(11, 21)}:${String(random.int(0, 59)).padStart(2, '0')}</span></div>
    <div class="row"><span>Server: ${random.pick(['Dana', 'Luis', 'Mei', 'Omar'])}</span><span>Table ${random.int(1, 40)}</span></div>
    <div class="hr"></div>${rows}<div class="hr"></div>
    <div class="row"><span>Subtotal</span><span>${dollars(subtotal)}</span></div>
    <div class="row"><span>Sales tax</span><span>${dollars(tax)}</span></div>
    <div class="row"><span>Amount</span><span>${dollars(subtotal + tax)}</span></div>
    <div class="row"><span>Tip</span><span class="hand">${dollars(tip)}</span></div>
    <div class="row"><b>TOTAL</b><span class="hand">${dollars(total)}</span></div>
    <div class="hr"></div>
    <div>${brand} ************${card}</div><div>APPROVED · AUTH ${random.int(100000, 999999)}</div>
    <div class="c" style="margin-top:10px">Thank you!</div>
  </div></body></html>`;

  return {
    truth: {
      documentType: 'receipt',
      currency: 'USD',
      merchant: name,
      date,
      subtotal: dollars(subtotal),
      taxTotal: dollars(tax),
      tip: dollars(tip),
      total: dollars(total),
      cardLastFour: card,
    },
    html,
    format: 'photo',
  };
}
