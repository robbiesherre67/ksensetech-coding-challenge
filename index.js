/**
 * DemoMed Assessment Solver
 * Run:
 *   node index.js
 *
 * Optional env:
 *   API_KEY=ak_... node index.js
 */

const BASE_URL = 'https://assessment.ksensetech.com/api';
const API_KEY = process.env.API_KEY || 'ak_ae557ca6698db7f65dd458a9e7aeba13f3f464214c104a48';

const DEFAULT_LIMIT = 20; // max allowed is 20

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isNonEmptyString(x) {
  return typeof x === 'string' && x.trim().length > 0;
}

function parseNumberStrict(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (!isNonEmptyString(x)) return null;
  const n = Number(x.trim());
  return Number.isFinite(n) ? n : null;
}

function parseBloodPressure(bp) {
  // Accept "120/80" with optional spaces. Reject missing parts or non-numeric.
  if (!isNonEmptyString(bp)) return { systolic: null, diastolic: null, valid: false };

  const parts = bp.split('/');
  if (parts.length !== 2) return { systolic: null, diastolic: null, valid: false };

  const sys = parseNumberStrict(parts[0]);
  const dia = parseNumberStrict(parts[1]);
  const valid = sys !== null && dia !== null;
  return { systolic: sys, diastolic: dia, valid };
}

function scoreBloodPressure(bp) {
  const { systolic, diastolic, valid } = parseBloodPressure(bp);
  if (!valid) return 0;

  // Determine category; if mismatch, use higher risk
  // Normal: sys <120 AND dia <80 => 1
  // Elevated: sys 120-129 AND dia <80 => 2
  // Stage 1: sys 130-139 OR dia 80-89 => 3
  // Stage 2: sys >=140 OR dia >=90 => 4
  let sysStage = 0;
  let diaStage = 0;

  if (systolic < 120) sysStage = 1;
  else if (systolic >= 120 && systolic <= 129) sysStage = 2;
  else if (systolic >= 130 && systolic <= 139) sysStage = 3;
  else if (systolic >= 140) sysStage = 4;

  if (diastolic < 80) diaStage = 1;
  else if (diastolic >= 80 && diastolic <= 89) diaStage = 3; // stage 1
  else if (diastolic >= 90) diaStage = 4;

  // Combine with rules:
  // Normal only if sys<120 AND dia<80 (both stage 1 in our encoding)
  if (systolic < 120 && diastolic < 80) return 1;
  // Elevated only if sys 120-129 AND dia<80
  if (systolic >= 120 && systolic <= 129 && diastolic < 80) return 2;

  // Otherwise stage 1/2 based on either:
  const stage = Math.max(sysStage, diaStage);
  return stage >= 4 ? 4 : 3;
}

function scoreTemperature(temp) {
  const t = parseNumberStrict(temp);
  if (t === null) return 0;
  if (t <= 99.5) return 0;
  if (t >= 99.6 && t <= 100.9) return 1;
  if (t >= 101.0) return 2;
  return 0;
}

function scoreAge(age) {
  const a = parseNumberStrict(age);
  if (a === null) return 0;
  if (a > 65) return 2;
  // Under 40 and 40-65 both map to 1 per spec
  return 1;
}

function hasDataQualityIssue(p) {
  const bpOk = parseBloodPressure(p.blood_pressure).valid;
  const tOk = parseNumberStrict(p.temperature) !== null;
  const aOk = parseNumberStrict(p.age) !== null;
  return !(bpOk && tOk && aOk);
}

async function fetchWithRetry(url, options = {}, maxRetries = 8) {
  let attempt = 0;
  let backoff = 300; // ms
  while (true) {
    attempt++;
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'x-api-key': API_KEY,
          ...(options.headers || {}),
        },
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : backoff;
        await sleep(Math.max(waitMs, backoff));
        backoff = Math.min(backoff * 2, 5000);
        if (attempt <= maxRetries) continue;
      }

      if (res.status === 500 || res.status === 503) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
        if (attempt <= maxRetries) continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      // Sometimes inconsistent formats—try json, otherwise throw
      const data = await res.json();
      return data;
    } catch (err) {
      if (attempt > maxRetries) throw err;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
    }
  }
}

async function getAllPatients() {
  const all = [];
  let page = 1;
  let totalPages = null;

  while (true) {
    const url = `${BASE_URL}/patients?page=${page}&limit=${DEFAULT_LIMIT}`;
    const payload = await fetchWithRetry(url);

    const data = Array.isArray(payload?.data) ? payload.data : [];
    all.push(...data);

    const pag = payload?.pagination || {};
    if (typeof pag.totalPages === 'number') totalPages = pag.totalPages;

    const hasNext =
      typeof pag.hasNext === 'boolean'
        ? pag.hasNext
        : (totalPages ? page < totalPages : data.length === DEFAULT_LIMIT);

    if (!hasNext) break;
    page++;

    // small pacing to reduce 429s
    await sleep(120);
  }

  return all;
}

function analyzePatients(patients) {
  const highRisk = [];
  const fever = [];
  const dq = [];

  for (const p of patients) {
    const id = p.patient_id;
    if (!isNonEmptyString(id)) continue;

    const bp = scoreBloodPressure(p.blood_pressure);
    const tmp = scoreTemperature(p.temperature);
    const age = scoreAge(p.age);
    const total = bp + tmp + age;

    if (total >= 4) highRisk.push(id);

    const tVal = parseNumberStrict(p.temperature);
    if (tVal !== null && tVal >= 99.6) fever.push(id);

    if (hasDataQualityIssue(p)) dq.push(id);
  }

  // De-dupe + stable sort for deterministic submissions
  const uniqSort = (arr) => Array.from(new Set(arr)).sort();
  return {
    high_risk_patients: uniqSort(highRisk),
    fever_patients: uniqSort(fever),
    data_quality_issues: uniqSort(dq),
  };
}

async function submitResults(results) {
  const url = `${BASE_URL}/submit-assessment`;
  return fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  });
}

(async function main() {
  console.log('Fetching patients...');
  const patients = await getAllPatients();
  console.log(`Fetched ${patients.length} patients`);

  console.log('Analyzing...');
  const results = analyzePatients(patients);

  console.log('Submitting...');
  const response = await submitResults(results);

  console.log('--- SUBMITTED PAYLOAD ---');
  console.log(JSON.stringify(results, null, 2));
  console.log('--- API RESPONSE ---');
  console.log(JSON.stringify(response, null, 2));
})().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
