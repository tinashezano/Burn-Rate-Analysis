/** Checks statement parsing: number formats, date order, and block detection. */
import { parseStatement } from '../server/parse.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = expected === null ? actual === null
    : typeof expected === 'number' ? Math.abs(actual - expected) < 1e-9
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const parse = (csv, opts) => parseStatement(Buffer.from(csv, 'utf8'), 'test.csv', opts);
const oneBlock = (csv, opts) => parse(csv, opts).sheets[0].blocks[0];

console.log('\nAmount formats');
{
  // Each row is written in a different convention but means the same thing.
  const csv = ['Date,Description,Amount',
    '01/08/2026,anglo thousands,"1,234.56"',
    '02/08/2026,euro thousands,"1.234,56"',
    '03/08/2026,euro decimal only,"500,00"',
    '04/08/2026,spaced thousands,1 234.56',
    '05/08/2026,bracket negative,"(1,234.56)"',
    '06/08/2026,trailing DR,1234.56 DR',
    '07/08/2026,trailing CR,1234.56 CR',
    '08/08/2026,rand prefix,R 1 234.56',
    '09/08/2026,plain negative,-0.42',
  ].join('\n');
  const rows = oneBlock(csv).rows;
  check('anglo 1,234.56', rows[0].amount, 1234.56);
  check('euro 1.234,56', rows[1].amount, 1234.56);
  check('euro 500,00 is five hundred', rows[2].amount, 500);
  check('spaced 1 234.56', rows[3].amount, 1234.56);
  check('(1,234.56) is negative', rows[4].amount, -1234.56);
  check('trailing DR is negative', rows[5].amount, -1234.56);
  check('trailing CR is positive', rows[6].amount, 1234.56);
  check('R prefix stripped', rows[7].amount, 1234.56);
  check('-0.42', rows[8].amount, -0.42);
}

console.log('\nDebit and credit columns');
{
  const csv = ['Date,Description,Debit,Credit,Balance',
    '01/08/2026,Opening Balance,,,1000.00',
    '02/08/2026,payment,1234.56,,-234.56',
    '03/08/2026,receipt,,500.00,265.44'].join('\n');
  const b = oneBlock(csv);
  check('opening balance read', b.opening, 1000);
  check('debit becomes negative', b.rows[0].amount, -1234.56);
  check('credit stays positive', b.rows[1].amount, 500);
  check('closing balance read', b.closing, 265.44);
  check('opening + movement = closing',
    b.opening + b.rows.reduce((s, r) => s + r.amount, 0), b.closing);
}

console.log('\nDate handling');
{
  const csv = ['Date,Description,Amount',
    '03/08/2026,ambiguous,100',
    '25/08/2026,unambiguous,100'].join('\n');
  check('day-first reads 03/08 as 3 August', oneBlock(csv).rows[0].date, '2026-08-03');
  check('month-first reads 03/08 as 8 March',
    oneBlock(csv, { dayFirst: false }).rows[0].date, '2026-03-08');
  check('a day above 12 settles the order regardless',
    oneBlock(csv, { dayFirst: false }).rows[1].date, '2026-08-25');
  check('swap corrects an already-swapped source',
    oneBlock(csv, { swapDayMonth: true }).rows[0].date, '2026-03-08');
}

console.log('\nDescending statements');
{
  const csv = ['Date,Description,Amount,Balance',
    '05/08/2026,newest,-100,900',
    '04/08/2026,older,-50,1000',
    '03/08/2026,Opening Balance,,1050'].join('\n');
  const b = oneBlock(csv);
  check('newest-first detected', b.descending, true);
  check('rows re-ordered oldest first', b.rows[0].description, 'older');
  check('closing taken from the newest row', b.closing, 900);
}

console.log('\nSeveral accounts in one file');
{
  const csv = ['Account Description : First Account',
    'Account Number : 111222333',
    'Date,Description,Amount',
    '01/08/2026,one,100',
    '',
    'Account Description : Second Account',
    'Account Number : 444555666',
    'Date,Description,Amount',
    '02/08/2026,two,200'].join('\n');
  const blocks = parse(csv).sheets[0].blocks;
  check('two blocks found', blocks.length, 2);
  check('first account number', blocks[0].accountHint.number, '111222333');
  check('second account number', blocks[1].accountHint.number, '444555666');
  check('rows split between blocks', [blocks[0].rows.length, blocks[1].rows.length], [1, 1]);
}

console.log('\nFiles that are not statements');
{
  const parsed = parse('just some text\nand more text');
  check('no blocks found in prose', parsed.sheets.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
