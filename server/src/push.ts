// Web Push (VAPID) notifications. Single-user: every stored subscription
// belongs to the owner, so a notification fans out to all of them.
//
// VAPID keys are generated once and persisted in the `settings` table; push
// subscriptions live in their own table. Both are in data/ (git-ignored).

import webpush from "web-push";
import { log } from "./logger.js";
import * as dbm from "./db.js";
import type { SessionMeta, SessionStatus } from "./protocol.js";

let publicKey: string | null = null;
let enabled = false;

// Subject is required by the spec but only used by push services to contact the
// sender; a mailto with the owner's address is conventional.
const VAPID_SUBJECT = "mailto:andrewmartinhall2@gmail.com";

export function initPush(): void {
  let pub = dbm.getSetting("vapidPublicKey");
  let priv = dbm.getSetting("vapidPrivateKey");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    dbm.setSetting("vapidPublicKey", pub);
    dbm.setSetting("vapidPrivateKey", priv);
    log.info("Generated new VAPID keypair for Web Push.");
  }
  webpush.setVapidDetails(VAPID_SUBJECT, pub, priv);
  publicKey = pub;
  enabled = true;
}

export function getVapidPublicKey(): string | null {
  return publicKey;
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

async function sendToAll(payload: PushPayload): Promise<void> {
  if (!enabled) return;
  const subs = dbm.listPushSubscriptions();
  const json = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, json);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 mean the subscription is gone — prune it.
        if (status === 404 || status === 410) {
          dbm.removePushSubscription(sub.endpoint);
        } else {
          log.warn(`Push send failed (${status ?? "?"}):`, err);
        }
      }
    }),
  );
}

// Notify on the states the owner cares about: waiting on input, finished, errored.
export function notifySessionStatus(
  session: SessionMeta,
  status: SessionStatus,
): void {
  let title: string;
  switch (status) {
    case "awaiting_input":
      title = "Needs your input";
      break;
    case "idle":
      title = "Task finished";
      break;
    case "error":
      title = "Session error";
      break;
    default:
      return; // running / anything else: no notification
  }
  const repoName = dbm.getRepo(session.repoId)?.name ?? session.repoId;
  void sendToAll({
    title: `${title} — ${repoName}`,
    body: session.title,
    url: `/chat/${encodeURIComponent(session.repoId)}/${encodeURIComponent(session.id)}`,
    tag: session.id,
  });
}
