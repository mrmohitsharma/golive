import type { Config } from './config.js';
import type { Repo, TournamentRow } from './repo.js';
import type { ChatService } from './chat.js';
import type { YouTubeService } from './youtube.js';
import type { FacebookService } from './facebook.js';

interface Reader {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  failures: number;
  /** YouTube: live chat id and page token. */
  chatId?: string | null;
  pageToken?: string | null;
}

interface Log {
  warn: (o: object | string, m?: string) => void;
}

/**
 * While a tournament is live, pulls YouTube live chat and Facebook live comments into the
 * combined chat feed. Each source runs on its own timer and backs off on errors.
 */
export class ChatReaders {
  private readers = new Map<string, { youtube?: Reader; facebook?: Reader }>();

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly chat: ChatService,
    private readonly youtube: YouTubeService,
    private readonly facebook: FacebookService,
    private readonly log: Log,
  ) {}

  /** Called whenever the tournament's live state is checked (go live, end, every ~10 s live). */
  async sync(t: TournamentRow, live: boolean): Promise<void> {
    const cur = this.readers.get(t.id) ?? {};
    this.readers.set(t.id, cur);
    const wantYt = live && this.youtube.enabled && Boolean(t.yt_broadcast_id) && t.outputs?.youtube?.enabled !== false;
    const wantFb = live && this.facebook.enabled && Boolean(t.fb_live_video_id);
    if (wantYt && !cur.youtube) cur.youtube = this.start(t.id, 'youtube', 0);
    if (!wantYt && cur.youtube) this.stop(t.id, 'youtube');
    if (wantFb && !cur.facebook) cur.facebook = this.start(t.id, 'facebook', 0);
    if (!wantFb && cur.facebook) this.stop(t.id, 'facebook');
  }

  private start(tid: string, source: 'youtube' | 'facebook', delayMs: number): Reader {
    const r: Reader = { timer: null, stopped: false, failures: 0 };
    this.chat.setSource(tid, source, { state: 'reading', error: null });
    const loop = async () => {
      if (r.stopped) return;
      let wait = (source === 'youtube' ? this.config.YOUTUBE_CHAT_POLL_SEC : this.config.FACEBOOK_COMMENTS_POLL_SEC) * 1000;
      try {
        const t = await this.repo.tournamentById(tid);
        if (!t) return;
        const minWait = source === 'youtube' ? await this.readYoutube(t, r) : await this.readFacebook(t);
        wait = Math.max(wait, minWait ?? 0);
        r.failures = 0;
        this.chat.setSource(tid, source, { state: 'reading', error: null, lastAt: new Date().toISOString() });
      } catch (err) {
        const e = err as { code?: string; message: string };
        r.failures++;
        const fatal = e.code === 'youtube_quota' || e.code === 'youtube_chat_unavailable';
        const msg = /permission|pages_read_user_content|\(#10\)|\(#200\)/i.test(e.message)
          ? 'Facebook did not allow reading comments. The club owner should connect Facebook again (new permission).'
          : e.message.slice(0, 200);
        this.chat.setSource(tid, source, { state: 'error', error: msg });
        if (r.failures === 1 || fatal) this.log.warn({ tournament: tid, source, err: e.message }, 'chat reader failed');
        if (fatal) return; // stays in error until the next broadcast
        wait = Math.min(120_000, wait * 2 ** Math.min(r.failures, 4));
      }
      if (!r.stopped) r.timer = setTimeout(() => void loop(), wait);
    };
    r.timer = setTimeout(() => void loop(), delayMs);
    return r;
  }

  private async readYoutube(t: TournamentRow, r: Reader): Promise<number> {
    if (!r.chatId) {
      r.chatId = await this.youtube.liveChatId(t);
      if (!r.chatId) throw Object.assign(new Error('Live chat is turned off for this YouTube broadcast.'), { code: 'youtube_chat_unavailable' });
    }
    const page = await this.youtube.chatPage(t, r.chatId, r.pageToken);
    r.pageToken = page.nextPageToken ?? r.pageToken;
    for (const it of page.items ?? []) {
      const type = it.snippet?.type;
      if (type && type !== 'textMessageEvent' && type !== 'superChatEvent') continue;
      const text = it.snippet?.displayMessage ?? '';
      if (!text) continue;
      await this.chat.add(t.id, {
        source: 'youtube',
        externalId: it.id,
        author: it.authorDetails?.displayName ?? 'YouTube viewer',
        authorKey: it.authorDetails?.channelId ?? it.id,
        text,
        at: it.snippet?.publishedAt ? new Date(it.snippet.publishedAt) : undefined,
      });
    }
    return page.pollingIntervalMillis ?? 0;
  }

  private async readFacebook(t: TournamentRow): Promise<number> {
    const list = await this.facebook.liveComments(t);
    // Oldest first so the feed keeps time order.
    for (const c of [...list].reverse()) {
      if (!c.message) continue;
      await this.chat.add(t.id, {
        source: 'facebook',
        externalId: c.id,
        author: c.from?.name ?? 'Facebook viewer',
        authorKey: c.from?.id ?? c.id,
        text: c.message,
        at: c.created_time ? new Date(c.created_time) : undefined,
      });
    }
    return 0;
  }

  private stop(tid: string, source: 'youtube' | 'facebook') {
    const cur = this.readers.get(tid);
    const r = cur?.[source];
    if (r) {
      r.stopped = true;
      if (r.timer) clearTimeout(r.timer);
      delete cur![source];
    }
    this.chat.setSource(tid, source, { state: 'off', error: null });
  }

  stopAll() {
    for (const [tid, cur] of this.readers) {
      if (cur.youtube) this.stop(tid, 'youtube');
      if (cur.facebook) this.stop(tid, 'facebook');
    }
  }
}
