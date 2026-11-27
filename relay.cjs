const fs = require('node:fs');
const crypto = require('node:crypto');

const USAGE = [
  '/relay jenkins <build-url> [minutes]',
  '/relay mr <CODING-MR-url> <sender-id> [minutes] | <registered-group-name>',
  '/relay status [id]',
  '/relay cancel <id>',
].join('\n');
const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED', 'NOT_BUILT']);

/** Accept only a numbered build under the locally configured Jenkins base. */
function jenkinsTarget(value, baseUrl) {
  if (!baseUrl) throw Error('Configure relayJenkinsBaseUrl first.');
  const base = new URL(baseUrl);
  const url = new URL(value);
  const root = base.pathname.replace(/\/+$/, '');
  if (![base, url].every(u => /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash)
      || url.origin !== base.origin || !url.pathname.startsWith(root + '/')) throw Error('Invalid Jenkins build URL.');
  const build = url.pathname.slice(root.length).match(/^(?:\/job\/[\w.%~+-]+)+\/([1-9]\d{0,8})\/?$/);
  if (!build || url.pathname.split('/').some(part => {
    const decoded = decodeURIComponent(part);
    return decoded === '.' || decoded === '..' || /[/\\%\u0000-\u001f]/.test(decoded);
  })) throw Error('A numbered Jenkins build URL is required.');
  return {url: url.href.replace(/\/?$/, '/'), number: Number(build[1])};
}

/** Use the complete project/repository/MR identity rather than matching display text. */
function mrUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.coding\.net$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !/^\/p\/[\w-]+\/d\/[\w.-]+\/git\/merge\/[1-9]\d*\/?$/.test(url.pathname)) throw Error('Invalid CODING MR URL.');
  return url.href.replace(/\/$/, '');
}

/** Run read-only watches independently of Codex turns; persist evidence before notification. */
function createRelay({file, baseUrl, fetchBuild = fetch, now = Date.now, notify = async () => {}}) {
  let jobs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(jobs)) throw Error('Invalid relay state.');
  let ticking = false;

  // Replace the ledger atomically so restart never observes a partial write.
  function save(next) {
    const kept = [...next.filter(j => j.state === 'waiting'), ...next.filter(j => j.state !== 'waiting').slice(0, 50)];
    fs.writeFileSync(file + '.tmp', JSON.stringify(kept), 'utf8');
    fs.renameSync(file + '.tmp', file);
    jobs = kept;
  }

  // Only the first terminal observation wins, even when cancellation races an API response.
  function finish(id, state, evidence = {}) {
    const job = jobs.find(j => j.id === id && j.state === 'waiting');
    if (!job) return;
    const done = {...job, state, evidence, finishedAt: now()};
    save([done, ...jobs.filter(j => j.id !== id)]);
    if (state !== 'cancelled') void Promise.resolve().then(() => notify(done)).catch(() => {});
  }

  function summary(j) {
    const detail = j.evidence?.messageId ? ' | DingTalk msgId=' + j.evidence.messageId + ' (signal only; verify CODING)'
      : j.evidence?.sha ? ' | checkout SHA=' + j.evidence.sha
      : j.kind === 'jenkins' && TERMINAL.has(j.state) ? ' | checkout SHA unavailable' : '';
    return j.id + ' | ' + j.kind + ' | ' + j.state + ' | ' + j.url + detail;
  }

  // The bridge supplies the owner scope and thread mapping, never the command text.
  function command(text, scope, threadId, groups) {
    const args = text.trim().split(/\s+/);
    const owned = jobs.filter(j => j.scope === scope);
    if (args[1] === 'status' && args.length <= 3) {
      return owned.filter(j => !args[2] || j.id === args[2]).slice(0, 10).map(summary).join('\n') || 'No relay jobs found.';
    }
    if (args[1] === 'cancel' && args.length === 3) {
      const job = owned.find(j => j.id === args[2] && j.state === 'waiting');
      if (!job) return 'No waiting relay job found.';
      finish(job.id, 'cancelled');
      return 'Cancelled relay ' + job.id;
    }
    if (args.length === 1) return USAGE;
    const kind = args[1];
    let target, minutes;
    if (kind === 'jenkins' && (args.length === 3 || args.length === 4)) {
      target = jenkinsTarget(args[2], baseUrl);
      minutes = args[3];
    } else if (kind === 'mr') {
      const match = text.match(/^\/relay\s+mr\s+(\S+)\s+([\w.@-]{1,160})(?:\s+(\d+))?\s+\|\s+([^\r\n]+)$/);
      if (!match) return USAGE;
      const matches = groups.filter(g => g.name === match[4].trim());
      if (matches.length !== 1) throw Error('The group must be uniquely registered and enabled for relay.');
      target = {url: mrUrl(match[1]), sender: match[2], group: matches[0].id};
      minutes = match[3];
    } else return USAGE;
    minutes = minutes === undefined ? 30 : Number(minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw Error('Use 1 to 120 minutes.');
    if (!threadId) throw Error('Open a Codex conversation before creating a relay.');
    const duplicate = owned.find(j => j.state === 'waiting' && j.threadId === threadId && j.kind === kind
      && j.url === target.url && j.group === target.group && j.sender === target.sender);
    if (duplicate) return 'Already watching: ' + summary(duplicate);
    if (jobs.filter(j => j.state === 'waiting').length >= 10) throw Error('At most 10 watches may be active.');
    const job = {id: crypto.randomUUID(), kind, scope, threadId, ...target, state: 'waiting', startedAt: now(), deadline: now() + minutes * 60000};
    save([job, ...jobs]);
    return 'Watching for up to ' + minutes + ' min: ' + summary(job);
  }

  // Ignore archived/old/replayed content and never forward the sender's raw text to Codex.
  function observeMr({group, sender, text, messageId, sentAt}) {
    if (!/^[\w+$=/.-]{1,250}$/.test(messageId || '') || !Number.isSafeInteger(sentAt) || sentAt > now() + 30000) return;
    const match = text.match(/^已合并[：:]?\s+(https:\/\/\S+)$/u);
    if (!match) return;
    let url;
    try {url = mrUrl(match[1]);} catch {return;}
    for (const job of jobs) {
      if (job.kind === 'mr' && job.state === 'waiting' && job.group === group && job.sender === sender
          && job.url === url && sentAt >= job.startedAt && sentAt < job.deadline && now() < job.deadline) {
        finish(job.id, 'mr-signal', {messageId});
      }
    }
  }

  // Poll only the build JSON API; do not follow redirects, send credentials, or call build actions.
  async function checkBuild(job) {
    try {
      const target = jenkinsTarget(job.url, baseUrl);
      const url = new URL('api/json', target.url);
      url.searchParams.set('tree', 'number,building,result,actions[lastBuiltRevision[SHA1]]');
      const response = await fetchBuild(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000)});
      if (!response.ok) return;
      const data = await response.json();
      if (now() >= job.deadline || data.number !== target.number || data.building !== false || !TERMINAL.has(data.result)) return;
      const shas = new Set((Array.isArray(data.actions) ? data.actions : []).map(a => a?.lastBuiltRevision?.SHA1)
        .filter(s => typeof s === 'string' && /^[a-f0-9]{40}$/i.test(s)).map(s => s.toLowerCase()));
      finish(job.id, data.result, shas.size === 1 ? {sha: [...shas][0]} : {});
    } catch {
      // An unavailable build API is not a build failure. The watch expires without a conclusion.
    }
  }

  // Serialize polling cycles while querying independent builds concurrently.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const job of jobs) if (job.state === 'waiting' && now() >= job.deadline) finish(job.id, 'expired');
      await Promise.all(jobs.filter(j => j.kind === 'jenkins' && j.state === 'waiting').map(checkBuild));
    } finally {ticking = false;}
  }

  /** Supply bounded, structured evidence only to the original private Codex conversation. */
  function context(scope, threadId) {
    return jobs.filter(j => j.scope === scope && j.threadId === threadId && j.state !== 'waiting' && j.state !== 'cancelled')
      .slice(0, 5).map(summary).join('\n');
  }

  return {command, observeMr, tick, summary, context};
}

module.exports = {createRelay, mrUrl};
