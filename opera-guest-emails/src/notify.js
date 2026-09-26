import { spawn } from 'node:child_process';
import { log } from './logger.js';

/**
 * Fire-and-forget notification. Two optional sinks, both configured under
 * `notify` in config.json:
 *   - webhookUrl: POSTs JSON {event, message, property, ...extra}
 *   - command:    shell command; gets NOTIFY_EVENT, NOTIFY_MESSAGE, NOTIFY_JSON
 *                 env vars (see scripts/notify-telegram.sh)
 * Never throws — a broken notifier must not mask the real exit status.
 */
export async function notify(cfg, event, message, extra = {}) {
  const payload = {
    event,
    message,
    property: cfg.property,
    host: process.env.HOSTNAME || '',
    time: new Date().toISOString(),
    ...extra,
  };
  const { webhookUrl, command } = cfg.notify || {};
  if (!webhookUrl && !command) {
    log.info(`[notify:${event}] (no notifier configured) ${message}`);
    return;
  }
  const jobs = [];
  if (webhookUrl) jobs.push(postWebhook(webhookUrl, payload));
  if (command) jobs.push(runCommand(command, payload));
  await Promise.allSettled(jobs);
}

async function postWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) log.warn(`Notify webhook returned HTTP ${res.status}`);
    else log.info(`Notify webhook sent (${payload.event})`);
  } catch (e) {
    log.warn(`Notify webhook failed: ${e.message}`);
  }
}

function runCommand(command, payload) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        NOTIFY_EVENT: payload.event,
        NOTIFY_MESSAGE: payload.message,
        NOTIFY_JSON: JSON.stringify(payload),
      },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', (e) => {
      log.warn(`Notify command failed to start: ${e.message}`);
      clearTimeout(timer);
      resolve();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) log.warn(`Notify command exited with code ${code}`);
      else log.info(`Notify command sent (${payload.event})`);
      resolve();
    });
  });
}
