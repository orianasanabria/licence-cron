// Chequea horas disponibles para Primera Licencia en nunoa.ingelan.cl (Agenda-T)
// Uso:  npm i playwright && npx playwright install chromium
//       NTFY_TOPIC=mi-topic-secreto node check-nunoa-licencia.mjs
// Notifica vía ntfy.sh (app gratis iOS/Android, suscríbete al mismo topic).

import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const URL = 'https://nunoa.ingelan.cl/';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const MAX_MONTHS = 3;
const STATE = 'cupos.json'; // cupos vistos en la última corrida
const LOG = 'cupos.csv';    // historial: cuándo aparece/desaparece cada cupo

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
  const current = []; // ["5/11/2026 09:00", ...]
  for (const d of days) {
    const slots = await slotsForDay(page, d);
    for (const h of slots) current.push(`${d.day}/${d.m}/${d.y} ${h}`);
  }

  // Estado previo -> detectar cupos nuevos / tomados
  const prev = new Set(existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : []);
  const now = new Set(current);
  const nuevos = current.filter(k => !prev.has(k));
  const tomados = [...prev].filter(k => !now.has(k));
  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Santiago' }); // 2026-11-05 17:10:00

  if (nuevos.length || tomados.length) {
    if (!existsSync(LOG)) appendFileSync(LOG, 'detectado_santiago,evento,fecha,hora\n');
    const rows = [
      ...nuevos.map(k => `${ts},aparece,${k.replace(' ', ',')}`),
      ...tomados.map(k => `${ts},desaparece,${k.replace(' ', ',')}`),
    ];
    appendFileSync(LOG, rows.join('\n') + '\n');
    writeFileSync(STATE, JSON.stringify([...now].sort(), null, 1) + '\n');
  }
  console.log(`[${ts}] días habilitados: ${days.length} | cupos: ${current.length} | nuevos: ${nuevos.length} | tomados: ${tomados.length}`);

  if (nuevos.length) {
    await notify(`Cupos nuevos:\n${nuevos.join('\n')}`);
  } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    // Corrida manual: avisar igual, para probar ntfy de punta a punta
    await notify(`[test manual] ${current.length ? `Cupos ya conocidos:\n${current.join('\n')}` : `Sin horas (días habilitados: ${days.length})`}`);
  }
} catch (e) {
  console.error('Fallo el chequeo:', e.message, '| URL:', page.url());
  await page.screenshot({ path: 'debug-error.png', fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
