// Chequea horas disponibles para Primera Licencia en nunoa.ingelan.cl (Agenda-T)
// Uso:  npm i playwright && npx playwright install chromium
//       NTFY_TOPIC=mi-topic-secreto node check-nunoa-licencia.mjs
// Notifica vía ntfy.sh (app gratis iOS/Android, suscríbete al mismo topic).

import { chromium } from 'playwright';

const URL = 'https://nunoa.ingelan.cl/';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const MAX_MONTHS = 3;

async function notify(msg) {
  console.log(msg);
  if (!NTFY_TOPIC) return;
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: 'Licencia Ñuñoa', Priority: 'high', Click: URL },
    body: msg,
  });
}

async function pickSelect(page, id, value) {
  await page.waitForFunction(
    ([id, v]) => [...document.getElementById(id).options].some(o => o.value === v),
    [id, value], { timeout: 15000 },
  );
  await page.selectOption(`#${id}`, value); // dispara change -> carga el siguiente combo
}

async function goToCalendar(page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await pickSelect(page, 'txt_sucursalC', '3');      // Municipalidad de Ñuñoa
  await pickSelect(page, 'txt_centroAtencion', '3'); // Licencia de Conducir
  await pickSelect(page, 'txt_servicios', '1');      // Primera Licencia
  await page.getByRole('link', { name: 'Siguiente', exact: true }).click();
  await page.waitForURL(/seleccionarCalendario/);
  await page.waitForLoadState('networkidle');
}

async function listEnabledDays(page) {
  await page.getByPlaceholder('Seleccione una Fecha').click();
  await page.waitForSelector('#ui-datepicker-div');
  return page.evaluate(async (max) => {
    const $dp = jQuery('#ui-datepicker-div');
    const out = [];
    for (let i = 0; i < max; i++) {
      const title = $dp.find('.ui-datepicker-title').text().trim();
      $dp.find('td[data-handler="selectDay"]').each((_, td) => {
        out.push({ title, day: td.textContent.trim(),
          m: +td.dataset.month + 1, y: +td.dataset.year });
      });
      const next = $dp.find('.ui-datepicker-next');
      if (next.hasClass('ui-state-disabled')) break;
      next.click();
    }
    return out;
  }, MAX_MONTHS);
}

async function slotsForDay(page, d) {
  // TODO: validar markup de horarios cuando haya cupos
  await goToCalendar(page);
  await page.getByPlaceholder('Seleccione una Fecha').click();
  await page.evaluate(({ day, m, y }) => {
    const $dp = jQuery('#ui-datepicker-div');
    for (let i = 0; i < 12; i++) {
      const cell = $dp.find(`td[data-handler="selectDay"][data-month="${m - 1}"][data-year="${y}"] a`)
        .filter((_, a) => a.textContent.trim() === day);
      if (cell.length) { cell.click(); return; }
      $dp.find('.ui-datepicker-next').click();
    }
  }, d);
  await page.getByRole('link', { name: 'Siguiente', exact: true }).click();
  await page.waitForURL(/seleccionarHorarios/);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const text = await page.locator('body').innerText();
  return [...new Set(text.match(/\b\d{1,2}:\d{2}\b/g) || [])];
}

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await goToCalendar(page);
  const days = await listEnabledDays(page);
  const found = [];
  for (const d of days) {
    const slots = await slotsForDay(page, d);
    if (slots.length) found.push(`${d.day}/${d.m}/${d.y}: ${slots.join(', ')}`);
  }
  if (found.length) await notify(`Horas disponibles:\n${found.join('\n')}`);
  else console.log(`[${new Date().toISOString()}] Sin horas (días habilitados: ${days.length})`);
} catch (e) {
  console.error('Fallo el chequeo:', e.message, '| URL:', page.url());
  await page.screenshot({ path: 'debug-error.png', fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
