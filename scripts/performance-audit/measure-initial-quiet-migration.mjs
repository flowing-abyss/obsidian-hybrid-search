/* global structuredClone */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const protocol = Object.freeze({
  name: 'quiet-initial-v1',
  sampleIntervalMs: 1000,
  maximumSampleGapMs: 3000,
  admissionQuietMs: 30000,
  individualExternalCpuLimit: 20,
  aggregateExternalCpuLimit: 50,
  measuredOrders: Object.freeze(
    [
      ['base', 'candidate'],
      ['candidate', 'base'],
      ['base', 'candidate'],
    ].map(Object.freeze),
  ),
  warmupOrder: Object.freeze(['candidate', 'base']),
  maximumMeasuredAttempts: 6,
  deadlineMs: 45 * 60 * 1000,
});

export function descendantPids(rows, rootPid) {
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return owned;
}

export function classifyWindow(samples, from, to) {
  const reasons = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return { eligible: false, reasons: [{ code: 'invalid-window' }] };
  }
  const first = samples.findLastIndex((sample) => sample.at <= from);
  const last = samples.findIndex((sample) => sample.startedAt >= to);
  if (first < 0) reasons.push({ code: 'missing-start-coverage' });
  if (last < 0) reasons.push({ code: 'missing-end-coverage' });
  const selected = samples.slice(Math.max(0, first), last < 0 ? undefined : last + 1);
  if (!selected.length) reasons.push({ code: 'missing-samples' });
  let maximumExternalProcessCpu = 0;
  let maximumAggregateExternalCpu = 0;
  for (const [index, sample] of selected.entries()) {
    if (sample.error) reasons.push({ code: 'sample-error', at: sample.at });
    if (!sample.collectorObserved) reasons.push({ code: 'collector-missing', at: sample.at });
    if (
      !Number.isFinite(sample.startedAt) ||
      !Number.isFinite(sample.at) ||
      sample.at < sample.startedAt ||
      sample.at - sample.startedAt > protocol.maximumSampleGapMs
    ) {
      reasons.push({ code: 'sample-duration', at: sample.at });
    }
    if (
      index &&
      (sample.at <= selected[index - 1].at ||
        sample.at - selected[index - 1].at > protocol.maximumSampleGapMs)
    ) {
      reasons.push({ code: 'sample-gap', at: sample.at });
    }
    if (!Array.isArray(sample.rows))
      reasons.push({ code: 'missing-process-inventory', at: sample.at });
    let total = 0;
    for (const row of sample.rows ?? []) {
      if (!Number.isFinite(row.cpu) || row.cpu < 0 || typeof row.owned !== 'boolean') {
        reasons.push({ code: 'invalid-process-cpu', at: sample.at, pid: row.pid });
        continue;
      }
      if (row.owned) continue;
      total += row.cpu;
      maximumExternalProcessCpu = Math.max(maximumExternalProcessCpu, row.cpu);
      if (row.cpu >= protocol.individualExternalCpuLimit) {
        reasons.push({ code: 'external-process-cpu', at: sample.at, pid: row.pid, cpu: row.cpu });
      }
    }
    // ps prints decimal percentages; avoid binary summation moving an exact limit below itself.
    total = Math.round(total * 1e6) / 1e6;
    maximumAggregateExternalCpu = Math.max(maximumAggregateExternalCpu, total);
    if (total >= protocol.aggregateExternalCpuLimit) {
      reasons.push({ code: 'external-aggregate-cpu', at: sample.at, cpu: total });
    }
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    from,
    to,
    firstSample: first,
    lastSample: last,
    sampleCount: selected.length,
    maximumExternalProcessCpu,
    maximumAggregateExternalCpu,
  };
}

export function pairEligibility(runs) {
  const reasons = [];
  if (runs.length !== 2) reasons.push({ code: 'incomplete-pair' });
  for (const [leg, run] of runs.entries()) {
    if (!run.eligibility?.eligible) reasons.push({ code: 'ineligible-leg', leg });
  }
  return { eligible: reasons.length === 0, reasons };
}

export function admissionEligibility(samples, beganAt) {
  const latest = samples.at(-1);
  if (!latest || latest.startedAt - beganAt < protocol.admissionQuietMs) {
    return { eligible: false, reasons: [{ code: 'admission-window-not-elapsed' }] };
  }
  return classifyWindow(samples, latest.startedAt - protocol.admissionQuietMs, latest.startedAt);
}

export function sanitizedHostRows(output, collectorPid) {
  const labels = new Set([
    'node',
    'npm',
    'python',
    'python3',
    'ps',
    'sh',
    'zsh',
    'bash',
    'Obsidian',
    'WindowServer',
    'kernel_task',
    'mds',
    'mds_stores',
    'mdworker',
    'mdworker_shared',
    'AeroSpace',
    'syncthing',
    'codex',
  ]);
  const rows = output
    .trim()
    .split('\n')
    .map((line) => {
      // eslint-disable-next-line sonarjs/super-linear-regex -- Frozen parser consumes bounded OS ps rows, not network input.
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match || !Number.isFinite(Number(match[3])) || Number(match[3]) < 0) {
        throw new Error('Invalid host process row');
      }
      const program = path.basename(match[5].split(/\s+/)[0]);
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpu: Number(match[3]),
        rssKiB: Number(match[4]),
        program: labels.has(program) ? program : 'other',
      };
    });
  if (new Set(rows.map((row) => row.pid)).size !== rows.length)
    throw new Error('Duplicate host process row');
  const owned = descendantPids(rows, collectorPid);
  return rows.map((row) => ({ ...row, owned: owned.has(row.pid) }));
}

function eligibilityFixtures() {
  const rows = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 20, ppid: 1 },
  ];
  assert.deepEqual(
    [...descendantPids(rows, 10)].sort((a, b) => a - b),
    [10, 11, 12],
  );
  const parsed = sanitizedHostRows(
    [
      '1 0 10.0 100 /usr/bin/node root-agent --token ROOT_SECRET',
      '10 1 1.0 100 /usr/bin/node collector --token COLLECTOR_SECRET',
      '11 10 500.0 100 /usr/bin/node model --token CHILD_SECRET',
      '20 1 20.0 100 /usr/bin/node unrelated --token SIBLING_SECRET',
    ].join('\n'),
    10,
  );
  assert.deepEqual(
    parsed.map((x) => [x.pid, x.owned]),
    [
      [1, false],
      [10, true],
      [11, true],
      [20, false],
    ],
  );
  assert.equal(
    JSON.stringify(parsed).includes('SECRET'),
    false,
    'host metadata must discard all command arguments',
  );
  assert.throws(() => sanitizedHostRows('unparseable process row', 10), /host process row/);
  const quiet = Array.from({ length: 5 }, (_, i) => ({
    startedAt: i * 1000,
    at: i * 1000 + 10,
    collectorObserved: true,
    rows: [
      { pid: 10, owned: true, cpu: 500 },
      { pid: 20, owned: false, cpu: 19.9 },
    ],
  }));
  assert.equal(
    classifyWindow(quiet, 500, 3500).eligible,
    true,
    'benchmark CPU is excluded by ancestry',
  );
  const one = structuredClone(quiet);
  one[2].rows[1].cpu = 20;
  assert.equal(
    classifyWindow(one, 500, 3500).eligible,
    false,
    'the exact individual limit rejects external work',
  );
  const total = structuredClone(quiet);
  total[2].rows = [16, 17, 17].map((cpu, i) => ({ pid: 30 + i, owned: false, cpu }));
  assert.equal(
    classifyWindow(total, 500, 3500).eligible,
    false,
    'aggregate CPU at the exact limit rejects a window',
  );
  const fractional = structuredClone(quiet);
  fractional[2].rows = [...Array(166).fill(0.3), 0.2].map((cpu, i) => ({
    pid: 30 + i,
    owned: false,
    cpu,
  }));
  assert.equal(
    classifyWindow(fractional, 500, 3500).eligible,
    false,
    'decimal display values totaling the limit must not round below it',
  );
  assert.equal(
    classifyWindow(quiet.slice(1), 500, 3500).eligible,
    false,
    'missing starting coverage cannot pass',
  );
  assert.equal(
    classifyWindow(quiet.slice(0, -1), 500, 3500).eligible,
    false,
    'missing ending coverage cannot pass',
  );
  const missing = [quiet[0], quiet[4]];
  assert.equal(classifyWindow(missing, 500, 3500).eligible, false, 'a sampler pause cannot pass');
  const error = structuredClone(quiet);
  error[2].error = 'sample-failed';
  assert.equal(classifyWindow(error, 500, 3500).eligible, false, 'sampler errors cannot pass');
  const absent = structuredClone(quiet);
  absent[2].collectorObserved = false;
  assert.equal(
    classifyWindow(absent, 500, 3500).eligible,
    false,
    'an incomplete process inventory cannot pass',
  );
  const unknown = structuredClone(quiet);
  unknown[2].rows[1].cpu = Number.NaN;
  assert.equal(classifyWindow(unknown, 500, 3500).eligible, false, 'unknown CPU cannot pass');
  const healthy = { eligibility: { eligible: true, reasons: [] } };
  const contaminated = { eligibility: { eligible: false, reasons: ['external CPU'] } };
  assert.equal(pairEligibility([healthy, healthy]).eligible, true);
  assert.equal(pairEligibility([healthy, contaminated]).eligible, false);
  assert.equal(pairEligibility([contaminated, healthy]).eligible, false);
  assert.equal(pairEligibility([healthy]).eligible, false, 'a half pair cannot count');
  const admissionSamples = Array.from({ length: 33 }, (_, i) => ({
    startedAt: i * 1000,
    at: i * 1000 + 10,
    collectorObserved: true,
    rows: [
      { pid: 10, owned: true, cpu: 0 },
      { pid: 20, owned: false, cpu: 1 },
    ],
  }));
  assert.equal(admissionEligibility(admissionSamples, 1000).eligible, true);
  assert.equal(
    admissionEligibility(admissionSamples, 31000).eligible,
    false,
    'prior benchmark samples cannot satisfy a new quiet admission',
  );
  console.log('Pure eligibility fixtures passed; no runtime or model was imported.');
}

async function main() {
  assert.deepEqual(process.argv.slice(2), [], 'This frozen collector accepts no runtime overrides');
  assert.equal(process.version, 'v26.12.0');
  const root = path.dirname(fileURLToPath(import.meta.url));
  const beganAt = Date.now();
  const runLabel = `${beganAt}-quiet-${process.pid}`;
  const hostFile = path.join(root, `quiet-initial-host-${runLabel}.jsonl`);
  const resultFile = path.join(root, `quiet-initial-measurements-${runLabel}.json`);
  const archive = path.join(root, 'harness-archives', `quiet-initial-${runLabel}`);
  const expectedRuntime = {
    base: {
      package: '9c4ef2a4dbcd5875603def83c35f48638c20cc3707f1df471515e8e6960de3c8',
      lock: 'f2bb72442a1ae33fe3cf4f4c1bbad080074d57d9c78615e79cc940a64e21cada',
    },
    candidate: {
      package: 'a8066d4d93a05a18d94f9969caab919814c705c5a36e2ecc861ed0f9f025b52b',
      lock: '1b4a0903adb87ee93412af2c98792590a77524a3392643ac5fc95ba8c18b64e5',
    },
  };
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const runtimeHashes = () =>
    Object.fromEntries(
      ['base', 'candidate'].map((revision) => [
        revision,
        {
          package: digest(
            path.join(root, 'runtime', revision, 'obsidian-hybrid-search-0.16.4.tgz'),
          ),
          lock: digest(path.join(root, 'runtime', revision, 'package-lock.json')),
        },
      ]),
    );
  assert.deepEqual(runtimeHashes(), expectedRuntime, 'The frozen package/lock inputs must match');
  fs.mkdirSync(archive, { recursive: false });
  const archivedFiles = [
    'measure-initial-quiet-migration.mjs',
    'quiet-initial-protocol.md',
    'harness-safe-cleanup.mjs',
    'telemetry.mjs',
    'queries.json',
    'required-facts.json',
    'corpus-manifest.json',
    'runtime-source-commit.json',
  ];
  const harnessHashes = {};
  for (const name of archivedFiles) {
    const source = path.join(root, name);
    harnessHashes[name] = digest(source);
    fs.copyFileSync(source, path.join(archive, name));
  }
  assert.equal(
    harnessHashes['harness-safe-cleanup.mjs'],
    '9c7d8ee2083825f7b01d6a59b795ad87e81a5e9722bd4a37af4f6069a397ecbe',
  );
  assert.equal(
    harnessHashes['telemetry.mjs'],
    '6e20bbd05a329719df33c0ceacf9e50899f9da271d8d8c12a763b81abd476a18',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'corpus-manifest.json')));
  const expectedPaths = manifest.files.map((file) => file.path.normalize('NFC')).sort();
  const result = {
    runLabel,
    mode: 'quiet-initial',
    status: 'running',
    beganAt,
    deadlineAt: beganAt + protocol.deadlineMs,
    node: process.version,
    protocol,
    runtime: expectedRuntime,
    harnessHashes,
    archive,
    hostFile,
    model: 'Xenova/multilingual-e5-small',
    warmup: null,
    attempts: [],
    acceptedAttempts: [],
    admissions: [],
    failures: [],
    cleanup: null,
  };
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(hostFile, '');
  save();
  const samples = [];
  let pendingSample;
  let monitorFailure;
  const sample = () => {
    if (pendingSample) return pendingSample;
    const startedAt = Date.now();
    pendingSample = new Promise((resolve) => {
      execFile(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Preserve the frozen ps invocation on the isolated hosted runner.
        'ps',
        ['-axo', 'pid=,ppid=,pcpu=,rss=,command='],
        { encoding: 'utf8', timeout: protocol.maximumSampleGapMs, maxBuffer: 8 * 1024 * 1024 },
        (error, output) => {
          let rows = [];
          let sampleError;
          try {
            if (error) sampleError = 'host-process-sample-failed';
            else rows = sanitizedHostRows(output, process.pid);
          } catch {
            sampleError = 'host-process-parse-failed';
          }
          const snapshot = {
            index: samples.length,
            startedAt,
            at: Date.now(),
            error: sampleError,
            collectorObserved: rows.some((row) => row.pid === process.pid),
            observedProcesses: rows.length,
            rows: rows.filter((row) => row.cpu > 0 || row.owned),
          };
          samples.push(snapshot);
          try {
            fs.appendFileSync(hostFile, JSON.stringify(snapshot) + '\n');
          } catch (error) {
            monitorFailure = error;
          }
          pendingSample = undefined;
          resolve(snapshot);
        },
      );
    });
    return pendingSample;
  };
  const sampleAfter = async (time) => {
    let latest = await sample();
    if (latest.startedAt < time) latest = await sample();
    return latest;
  };
  // Imported only for actual collection, never for syntax/eligibility fixtures.
  const { prepareVault, cli, inspect, closureEvidence, stopAll } =
    await import('./harness-safe-cleanup.mjs');
  let stoppingReason;
  let stopPromise;
  const requestStop = (reason) => {
    if (stoppingReason) return;
    stoppingReason = reason;
    result.stopRequested = { reason, at: Date.now() };
    stopPromise = stopAll().catch((error) => {
      result.failures.push({ phase: 'deadline-cleanup', message: error.message });
    });
  };
  const onInterrupt = () => requestStop('interrupted');
  const onTerminate = () => requestStop('terminated');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const deadlineTimer = setTimeout(
    () => requestStop('deadline'),
    Math.max(0, result.deadlineAt - Date.now()),
  );
  const sampleTimer = setInterval(sample, protocol.sampleIntervalMs);
  const ensureRunning = () => {
    if (monitorFailure) throw monitorFailure;
    if (!stoppingReason && Date.now() >= result.deadlineAt) requestStop('deadline');
    if (stoppingReason) throw new Error(`Collection stopped: ${stoppingReason}`);
  };
  const admission = async (phase, attempt, revision) => {
    const entry = { phase, attempt, revision, beganAt: Date.now() };
    result.admissions.push(entry);
    for (;;) {
      ensureRunning();
      const decision = admissionEligibility(samples, entry.beganAt);
      entry.lastDecision = decision;
      if (decision.eligible) {
        entry.admittedAt = Date.now();
        save();
        return entry;
      }
      save();
      await delay(protocol.sampleIntervalMs);
    }
  };
  const checkHealth = (record, run) => {
    const db = record.db;
    assert.equal(db.integrity, 'ok');
    assert.deepEqual(db.foreign, []);
    assert.equal(db.notes, 1393);
    assert.equal(db.chunks, 3950);
    assert.equal(db.successfulChunks, 3950);
    assert.equal(db.vectors, 3950);
    assert.equal(db.failedChunks, 0);
    assert.equal(db.orphanVectors, 0);
    assert.deepEqual(db.failures, []);
    assert.deepEqual(db.duplicates, []);
    assert.deepEqual(db.paths.map((value) => value.normalize('NFC')).sort(), expectedPaths);
    const model = db.settings.find((setting) => setting.key === 'embedding_model')?.value;
    if (record.revision === 'candidate') assert.equal(model, 'local:Xenova/multilingual-e5-small');
    else {
      assert.ok(model === undefined || model === 'local:Xenova/multilingual-e5-small');
      db.knownOriginalProvenanceBug = model === undefined;
    }
    assert.equal(db.settings.find((setting) => setting.key === 'embedding_dim')?.value, '384');
    assert.equal(run.metrics.node, process.version);
    assert.ok(Number.isFinite(run.ms) && run.ms > 0);
    assert.ok(Number.isFinite(run.metrics.cpu.user) && Number.isFinite(run.metrics.cpu.system));
    const closure = closureEvidence().find((value) => value.id === path.basename(run.logs));
    assert.ok(closure, 'Every initial-index process must have saved closure evidence');
    assert.equal(closure.code, 0);
    assert.equal(closure.signal, null);
    assert.equal(closure.forced, false);
    assert.deepEqual(closure.descendantLeaks, []);
    record.closure = closure;
  };
  const runPair = async (pair) => {
    for (const revision of pair.order) {
      ensureRunning();
      const vault = prepareVault(`${runLabel}-${pair.phase}-${pair.attempt}-${revision}`);
      const admitted = await admission(pair.phase, pair.attempt, revision);
      ensureRunning();
      const record = { revision, vault, admission: admitted, beganAt: Date.now() };
      pair.runs.push(record);
      save();
      try {
        const run = await cli(revision, vault, ['reindex']);
        record.endedAt = Date.now();
        // Preserve the original timing/resource fields while keeping copied host metadata free of commands.
        record.run = {
          ...run,
          processTree: run.processTree.map((snapshot) => ({
            ...snapshot,
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructuring deliberately removes command arguments from the retained record.
            processes: snapshot.processes.map(({ command, ...process }) => process),
          })),
        };
        await sampleAfter(record.endedAt);
        record.eligibility = classifyWindow(samples, record.beganAt, record.endedAt);
        record.db = inspect(vault);
        checkHealth(record, run);
        record.healthy = true;
        ensureRunning();
      } catch (error) {
        record.endedAt ??= Date.now();
        record.error = error.message;
        throw error;
      } finally {
        save();
      }
    }
    pair.eligibility = pairEligibility(pair.runs);
    pair.endedAt = Date.now();
    assert.deepEqual(
      runtimeHashes(),
      expectedRuntime,
      'Package/lock inputs must stay frozen between pairs',
    );
    save();
  };
  try {
    await sample();
    result.warmup = {
      phase: 'warmup',
      attempt: 0,
      order: protocol.warmupOrder,
      runs: [],
      excluded: true,
    };
    await runPair(result.warmup);
    for (
      let attempt = 0;
      attempt < protocol.maximumMeasuredAttempts && result.acceptedAttempts.length < 3;
      attempt++
    ) {
      ensureRunning();
      const slot = result.acceptedAttempts.length;
      const pair = {
        phase: 'measured',
        attempt,
        slot,
        order: protocol.measuredOrders[slot],
        runs: [],
      };
      result.attempts.push(pair);
      await runPair(pair);
      if (pair.eligibility.eligible) result.acceptedAttempts.push(attempt);
      pair.accepted = pair.eligibility.eligible;
      save();
      console.log(
        JSON.stringify({
          phase: 'quiet-initial-pair',
          attempt,
          slot,
          eligible: pair.eligibility.eligible,
          acceptedPairs: result.acceptedAttempts.length,
          runs: pair.runs.map((run) => ({
            revision: run.revision,
            ms: run.run.ms,
            eligibility: run.eligibility,
          })),
        }),
      );
    }
    result.status = result.acceptedAttempts.length === 3 ? 'collected' : 'pending';
    if (result.status === 'pending') result.pendingReason = 'maximum-measured-attempts';
  } catch (error) {
    result.status = stoppingReason ? 'pending' : 'failed';
    result.pendingReason = stoppingReason;
    result.failures.push({ phase: 'collection', message: error.message, stack: error.stack });
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(sampleTimer);
    if (pendingSample) await pendingSample;
    if (stopPromise) await stopPromise;
    try {
      const stopped = await stopAll();
      result.cleanup = { stopped, closures: closureEvidence() };
      for (const closure of closureEvidence()) {
        assert.deepEqual(closure.descendantLeaks, []);
        if (!stoppingReason) {
          assert.equal(closure.code, 0);
          assert.equal(closure.forced, false);
        }
      }
      assert.deepEqual(runtimeHashes(), expectedRuntime);
      for (const name of archivedFiles)
        assert.equal(
          digest(path.join(root, name)),
          harnessHashes[name],
          `${name} changed during collection`,
        );
      // eslint-disable-next-line no-unsafe-finally -- The immediately enclosing catch records this failure and marks collection failed.
      if (monitorFailure) throw monitorFailure;
    } catch (error) {
      result.failures.push({ phase: 'final-cleanup-or-provenance', message: error.message });
      result.status = 'failed';
    }
    result.hostSampleCount = samples.length;
    result.endedAt = Date.now();
    save();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
  console.log(
    JSON.stringify({
      resultFile,
      hostFile,
      status: result.status,
      acceptedAttempts: result.acceptedAttempts,
    }),
  );
  if (result.status !== 'collected') process.exitCode = result.status === 'failed' ? 1 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) eligibilityFixtures();
  else await main();
}
