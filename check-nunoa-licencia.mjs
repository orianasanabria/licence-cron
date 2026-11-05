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
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC.trim())}`, {
    method: 'POST',
    headers: { Title: 'Licencia Nunoa', Priority: 'high', Click: URL, Tags: 'car' },
    body: msg,
  });
  const body = await res.text();
  console.log(`ntfy: HTTP ${res.status} topic_len=${NTFY_TOPIC.trim().length} ${body.slice(0, 200)}`);
  if (!res.ok) throw new Error(`ntfy respondió ${res.status}`);
}

async function pickSelect(page, id, value) {
  await page.waitForFunction(
    ([id, v]) => [...document.getElementById(id).options].some(o => o.value === v),
    [id, value], { timeout: 15000 },
  );
  await page.selectOption(`#${id}`, value); // dispara change -> carga el siguiente combo
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

// Clic en "Siguiente" y espera a cambiar de vista; reintenta y loguea si no navega
async function clickNext(page, urlRe) {
  for (let i = 1; i <= 2; i++) {
    await page.getByText('Siguiente', { exact: true }).locator('visible=true').first().click();
    try {
      await page.waitForURL(urlRe, { timeout: 10000 });
      await page.waitForLoadState('networkidle');
      return;
    } catch {
      const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      console.log(`Intento ${i}: no navegó a ${urlRe}. Texto visible: ${txt}`);
    }
  }
  throw new Error(`No se pudo avanzar a ${urlRe}`);
}

async function goToCalendar(page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await pickSelect(page, 'txt_sucursalC', '3');      // Municipalidad de Ñuñoa
  await pickSelect(page, 'txt_centroAtencion', '3'); // Licencia de Conducir
  await pickSelect(page, 'txt_servicios', '1');      // Primera Licencia
  await clickNext(page, /seleccionarCalendario/);
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
  const fecha = await page.getByPlaceholder('Seleccione una Fecha').inputValue();
  if (!fecha) { console.log(`Día ${d.day}/${d.m}: no se pudo seleccionar en el datepicker`); return []; }
  try {
    await clickNext(page, /seleccionarHorarios/);
  } catch {
    console.log(`Día ${fecha}: el sitio no deja avanzar (probablemente sin cupos) — se trata como sin horas`);
    return [];
  }
  await page.waitForTimeout(1500);
  const text = await page.locator('body').innerText();
  return [...new Set(text.match(/\b\d{1,2}:\d{2}\b/g) || [])];
}

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'es-CL', timezoneId: 'America/Santiago' });
page.on('dialog', async d => { console.log(`Dialog (${d.type()}): ${d.message()}`); await d.accept(); });
try {
  await goToCalendar(page);
  const days = await listEnabledDays(page);
  const found = [];
  for (const d of days) {
    const slots = await slotsForDay(page, d);
    if (slots.length) found.push(`${d.day}/${d.m}/${d.y}: ${slots.join(', ')}`);
  }
  if (found.length) await notify(`Horas disponibles:\n${found.join('\n')}`);
  else {
    const msg = `Sin horas (días habilitados: ${days.length})`;
    console.log(`[${new Date().toISOString()}] ${msg}`);
    // Corrida manual desde Actions: avisar igual, para probar ntfy de punta a punta
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') await notify(`[test manual] ${msg}`);
  }
} catch (e) {
  console.error('Fallo el chequeo:', e.message, '| URL:', page.url());
  await page.screenshot({ path: 'debug-error.png', fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
