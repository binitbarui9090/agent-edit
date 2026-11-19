// Drives the real app through a browser. Needs `npm run infra:up` and `npm run dev` running.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const email = `walkthrough+${Date.now()}@example.com`;
const password = 'correct horse battery staple';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const shot = (n) => page.screenshot({ path: `${shots}${n}.png` });

await page.goto(BASE);
await page.waitForURL('**/login');
ok('anonymous visitor is redirected to /login', true);
await page.getByRole('heading', { name: 'Sign in' }).waitFor();
await shot('01-login');

await page.getByRole('link', { name: 'Create an account' }).click();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Name').fill('Walkthrough');
await page.getByLabel('Password').fill('short');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText('Use at least 10 characters').waitFor();
ok('short password rejected by shared schema', true);
await shot('02-register-error');
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
ok('register lands on dashboard', page.url() === `${BASE}/`);
ok('empty state shown', await page.getByText('No projects yet').isVisible());
await shot('03-dashboard-empty');

await page.getByRole('link', { name: 'New project' }).click();
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByText('Name is required').waitFor();
ok('blank name rejected', true);
await page.getByLabel('Name').fill('Conference talk');
ok(
  'field error clears once the field is edited',
  (await page.getByText('Name is required').count()) === 0,
);
await page.getByRole('radio', { name: /9:16/ }).check({ force: true });
await page.getByText('1080 × 1920').waitFor();
ok('aspect change keeps resolution tier', true);
await page.getByRole('radio', { name: '29.97' }).check({ force: true });
await page.waitForTimeout(150);
await shot('04-new-project');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Conference talk' }).waitFor();
const projectUrl = page.url();
ok('create navigates to project page', /\/projects\/prj_/.test(projectUrl), projectUrl);
await shot('05-project');
await page.getByRole('link', { name: 'Settings' }).click();

await page.getByLabel('Name').fill('Conference talk v2');
await page.getByRole('radio', { name: '60', exact: true }).check({ force: true });
await page.getByRole('button', { name: 'Save changes' }).click();
await page.getByRole('status').getByText('Saved').waitFor();
await page.reload();
await page.getByRole('heading', { name: 'Conference talk v2' }).waitFor();
ok('rename persisted across reload', true);
ok(
  'frame rate persisted across reload',
  await page.getByRole('radio', { name: '60', exact: true }).isChecked(),
);
ok('vertical format persisted', await page.getByRole('radio', { name: /9:16/ }).isChecked());
ok(
  'Save disabled when clean',
  await page.getByRole('button', { name: 'Save changes' }).isDisabled(),
);

for (const name of ['Podcast ep. 14', 'Product launch cut']) {
  await page.goto(`${BASE}/projects/new`);
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('heading', { name }).waitFor();
}
await page.goto(BASE);
await page.getByRole('link', { name: 'Product launch cut' }).waitFor();
const names = await page
  .getByRole('list', { name: 'Projects' })
  .getByRole('link')
  .allTextContents();
ok(
  'most recently modified first',
  names[0] === 'Product launch cut' && names[2] === 'Conference talk v2',
  JSON.stringify(names),
);
await shot('06-dashboard');

await page.getByRole('link', { name: 'Podcast ep. 14' }).click();
await page.getByRole('link', { name: 'Settings' }).click();
await page.getByRole('button', { name: 'Delete project' }).click();
await page.getByRole('button', { name: 'Keep project' }).click();
ok(
  'delete can be cancelled',
  await page.getByRole('button', { name: 'Delete project' }).isVisible(),
);
await page.getByRole('button', { name: 'Delete project' }).click();
await shot('07-delete-confirm');
await page.getByRole('button', { name: 'Confirm delete' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
await page.getByRole('link', { name: 'Conference talk v2' }).waitFor();
ok(
  'deleted project gone from list',
  (await page.getByRole('link', { name: 'Podcast ep. 14' }).count()) === 0,
);

const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  storageState: await ctx.storageState(),
});
for (const [n, u] of [
  ['08-mobile-dashboard', BASE],
  ['09-mobile-new', `${BASE}/projects/new`],
  ['10-mobile-project', projectUrl],
  ['12-mobile-settings', `${projectUrl}/settings`],
]) {
  await mobile.goto(u);
  await mobile.waitForLoadState('networkidle');
  const o = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok(`no horizontal scroll at 390px: ${n}`, o <= 0, `overflow=${o}`);
  await mobile.screenshot({ path: `${shots}${n}.png`, fullPage: true });
}
await mobile.close();

await page.getByRole('button', { name: 'Sign out' }).click();
await page.waitForURL('**/login');
await page.goto(projectUrl);
await page.waitForURL('**/login');
ok('signed-out user cannot open a project', true);
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill('wrong password here');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('Wrong email or password').waitFor();
ok('wrong password shows an error', true);
await shot('11-login-error');
await page.getByLabel('Password').fill(password);
ok(
  'auth error clears once the form is edited',
  (await page.getByText('Wrong email or password').count()) === 0,
);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: 'Conference talk v2' }).waitFor();
ok('sign in restores projects', true);

const health = await (await page.request.get(`${BASE}/health/ready`)).json();
ok(
  'readiness sees mongo, redis and a live worker',
  health.mongo && health.redis && health.workers >= 1,
  JSON.stringify(health),
);

const expected = problems.filter((p) => !/401|Unauthorized/.test(p));
ok('no unexpected browser errors', expected.length === 0, JSON.stringify(expected));
console.log(
  '401 console lines (expected for signed-out probes):',
  problems.length - expected.length,
);
console.log('email', email);
await browser.close();
