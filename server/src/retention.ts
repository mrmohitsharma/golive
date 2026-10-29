import type { Repo } from './repo.js';

/**
 * Keeps only what the privacy policy promises (viewership engine):
 *  - watch-page viewers: device id and network hash removed 90 days after their last visit
 *    (the counts in reports stay);
 *  - lucky draw entries and "Remind me" numbers: deleted after 30 days;
 *  - winners' phone and email: removed 90 days after the win.
 */
export async function applyRetention(repo: Repo): Promise<{ viewers: number; entries: number; reminders: number; winners: number }> {
  const viewers = await repo.db.query(
    `UPDATE viewers SET viewer_key = NULL, net_hash = NULL, share_code = NULL, anonymised_at = now()
      WHERE anonymised_at IS NULL AND last_seen_at < now() - interval '90 days'`,
  );
  const entries = await repo.db.query(`DELETE FROM draw_entries WHERE created_at < now() - interval '30 days'`);
  const reminders = await repo.db.query(`DELETE FROM reminders WHERE COALESCE(sent_at, created_at) < now() - interval '30 days'`);
  const winners = await repo.db.query(
    `UPDATE wins SET phone = NULL, email = NULL, otp_hash = NULL WHERE created_at < now() - interval '90 days' AND (phone IS NOT NULL OR email IS NOT NULL)`,
  );
  return { viewers: viewers.rowCount ?? 0, entries: entries.rowCount ?? 0, reminders: reminders.rowCount ?? 0, winners: winners.rowCount ?? 0 };
}
