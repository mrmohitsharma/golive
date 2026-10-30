import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError } from '../errors.js';
import { userOf, verifyPrincipal, bearerFrom, type Principal } from '../auth.js';
import { adminGuard } from './web.js';

const CATEGORIES = ['streaming', 'billing', 'account', 'bug', 'question', 'other'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const MAX_FILE = 5 * 1024 * 1024;
const TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'image/gif': (b) => b.subarray(0, 4).toString() === 'GIF8',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};
const fileSchema = z.object({ name: z.string().trim().min(1).max(120), type: z.string().max(60), data: z.string().max(7_000_000) });
const files = z.array(fileSchema).max(5).default([]);

/**
 * Support tickets. Anyone can raise one (website visitors, club members, from the web app);
 * the requester follows it with a private link, the Go Live team answers in Admin > Support.
 */
export function registerSupportRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, repo, mailer, sessions } = ctx;
  const admin = adminGuard(ctx);
  const q = repo.db;
  const base = () => config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const dir = path.join(config.MEDIA_DIR, 'tickets');
  const big = { bodyLimit: 40 * 1024 * 1024 };

  /** Optional sign-in: tickets from signed-in people are linked to their account. */
  const who = async (req: FastifyRequest): Promise<Extract<Principal, { kind: 'user' }> | null> => {
    const t = bearerFrom(req);
    const p = t ? verifyPrincipal(config, t) : null;
    if (!p || p.kind !== 'user') return null;
    const ok = await sessions.check(p);
    return ok && ok.kind === 'user' ? ok : null;
  };

  const saveFiles = async (ticketId: string, messageId: number, list: z.infer<typeof files>) => {
    for (const f of list) {
      const buf = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length || buf.length > MAX_FILE) throw new HttpError(400, 'file_too_big', `${f.name}: files can be up to 5 MB.`);
      const check = TYPES[f.type];
      if (!check || !check(buf)) throw new HttpError(400, 'file_type', `${f.name}: attach PNG, JPG, WebP, GIF images or PDF files.`);
      const id = crypto.randomUUID();
      const rel = path.join(ticketId, id);
      fs.mkdirSync(path.join(dir, ticketId), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), buf);
      await q.query('INSERT INTO ticket_files (id, ticket_id, message_id, name, mime, size_bytes, path) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, ticketId, messageId, f.name.replace(/[^\w.\- ()]/g, '_'), f.type, buf.length, rel]);
    }
  };

  const load = async (where: string, val: string) => {
    const t = (
      await q.query(
        `SELECT t.*, o.name AS org_name, e.name AS event_name, a.name AS assignee_name, a.email AS assignee_email
           FROM tickets t LEFT JOIN orgs o ON o.id = t.org_id LEFT JOIN tournaments e ON e.id = t.tournament_id LEFT JOIN users a ON a.id = t.assigned_to
          WHERE ${where} = $1`,
        [val],
      )
    ).rows[0];
    if (!t) throw new HttpError(404, 'ticket_not_found', 'Ticket not found. Check the link in your email.');
    return t;
  };
  const dto = (t: any, team: boolean) => ({
    id: team ? t.id : undefined,
    number: t.number,
    key: team ? t.public_key : undefined,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    name: t.requester_name,
    email: t.requester_email,
    club: t.org_name ?? null,
    orgId: team ? t.org_id : undefined,
    event: t.event_name ?? null,
    eventId: t.tournament_id,
    assignedTo: team ? (t.assigned_to ? { id: t.assigned_to, name: t.assignee_name, email: t.assignee_email } : null) : undefined,
    lastReplyBy: t.last_reply_by,
    createdAt: new Date(t.created_at).toISOString(),
    updatedAt: new Date(t.updated_at).toISOString(),
  });
  const thread = async (ticketId: string, team: boolean) => {
    const msgs = (await q.query(`SELECT * FROM ticket_messages WHERE ticket_id = $1 ${team ? '' : 'AND NOT internal'} ORDER BY id`, [ticketId])).rows;
    const fl = (await q.query('SELECT id, message_id, name, mime, size_bytes FROM ticket_files WHERE ticket_id = $1 ORDER BY created_at', [ticketId])).rows;
    return msgs.map((m) => ({
      id: Number(m.id),
      kind: m.author_kind,
      author: m.author_name,
      body: m.body,
      internal: m.internal,
      at: new Date(m.created_at).toISOString(),
      files: fl.filter((f) => Number(f.message_id) === Number(m.id)).map((f) => ({ id: f.id, name: f.name, type: f.mime, size: f.size_bytes })),
    }));
  };
  const link = (t: { public_key: string }) => `${base()}/support/t/${t.public_key}`;
  const team = (t: any, subject: string, body: string[]) =>
    t.assigned_to && t.assignee_email
      ? mailer.send({ to: t.assignee_email, kind: 'ticket', subject, body, button: { text: 'Open the ticket', url: `${base()}/web/admin/support/${t.id}` } })
      : mailer.toTeam({ kind: 'ticket', subject, body, button: { text: 'Open the ticket', url: `${base()}/web/admin/support/${t.id}` } });

  // ---------------------------------------------------------------- raise a ticket (anyone)
  app.post('/api/support/tickets', big, async (req, reply) => {
    const me = await who(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        email: z.string().trim().toLowerCase().email().optional(),
        subject: z.string().trim().min(3).max(140),
        category: z.enum(CATEGORIES).default('question'),
        priority: z.enum(PRIORITIES).default('normal'),
        message: z.string().trim().min(5).max(10_000),
        eventId: z.string().uuid().nullish(),
        files,
        website: z.string().max(0).optional(), // a field people never fill: bots do
      })
      .parse(req.body);
    const name = me?.name ?? b.name;
    const email = (me?.email ?? b.email)?.toLowerCase();
    if (!name || !email) throw new HttpError(400, 'contact_required', 'Enter your name and email so we can reply.');
    const ipHash = crypto.createHash('sha256').update(`ticket:${req.ip}`).digest('hex').slice(0, 24);
    const recent = Number((await q.query<{ n: string }>("SELECT count(*)::text AS n FROM tickets WHERE user_id IS NULL AND (lower(requester_email) = $1 OR ip_hash = $2) AND created_at >= now() - interval '1 day'", [email, ipHash])).rows[0].n);
    if (!me && recent >= 5) throw new HttpError(429, 'too_many', 'You have raised several tickets today. Reply on an open one instead.');
    // The event must be one the person can see; it sets the club too.
    let orgId: string | null = null;
    let eventId: string | null = null;
    if (b.eventId && me) {
      const t = await repo.tournamentById(b.eventId);
      const role = t ? await repo.memberRole(t.org_id, me.id) : null;
      if (t && (role || me.platformAdmin)) (eventId = t.id), (orgId = t.org_id);
    }
    if (!orgId && me) orgId = (await repo.memberships(me.id))[0]?.org_id ?? null;
    const key = crypto.randomBytes(18).toString('base64url');
    const t = (
      await q.query(
        `INSERT INTO tickets (public_key, subject, category, priority, requester_name, requester_email, user_id, org_id, tournament_id, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [key, b.subject, b.category, me ? b.priority : b.priority === 'urgent' ? 'high' : b.priority, name, email, me?.id ?? null, orgId, eventId, ipHash],
      )
    ).rows[0];
    const m = (await q.query("INSERT INTO ticket_messages (ticket_id, author_kind, author_user_id, author_name, body) VALUES ($1, 'customer', $2, $3, $4) RETURNING id", [t.id, me?.id ?? null, name, b.message])).rows[0];
    try {
      await saveFiles(t.id, Number(m.id), b.files);
    } catch (err) {
      await q.query('DELETE FROM tickets WHERE id = $1', [t.id]);
      throw err;
    }
    void mailer.send({
      to: email,
      kind: 'ticket',
      subject: `[#${t.number}] We got your request: ${b.subject}`,
      body: [`Hi ${name.split(' ')[0]},`, 'Thanks for writing to us. Our team will reply here and by email. You can add details or screenshots any time with the link below.'],
      button: { text: 'View your ticket', url: link(t) },
    });
    void team(t, `${t.priority === 'urgent' ? 'URGENT ' : ''}New ticket #${t.number}: ${b.subject}`, [`From ${name} <${email}>, ${b.category}, priority ${t.priority}.`, b.message.slice(0, 600)]);
    reply.status(201);
    return { number: t.number, key, link: link(t) };
  });

  // ---------------------------------------------------------------- the requester's view (private link)
  app.get('/api/support/t/:key', async (req) => {
    const t = await load('t.public_key', z.string().min(10).max(60).parse((req.params as { key: string }).key));
    return { ticket: dto(t, false), messages: await thread(t.id, false) };
  });

  app.post('/api/support/t/:key/messages', big, async (req) => {
    const t = await load('t.public_key', z.string().min(10).max(60).parse((req.params as { key: string }).key));
    if (t.status === 'closed') throw new HttpError(409, 'ticket_closed', 'This ticket is closed. Raise a new one if you still need help.');
    const b = z.object({ body: z.string().trim().min(1).max(10_000), files }).parse(req.body);
    const m = (await q.query("INSERT INTO ticket_messages (ticket_id, author_kind, author_name, body) VALUES ($1, 'customer', $2, $3) RETURNING id", [t.id, t.requester_name, b.body])).rows[0];
    await saveFiles(t.id, Number(m.id), b.files);
    await q.query("UPDATE tickets SET status = 'open', last_reply_by = 'customer', updated_at = now() WHERE id = $1", [t.id]);
    void team(t, `Reply on #${t.number}: ${t.subject}`, [`${t.requester_name} wrote:`, b.body.slice(0, 600)]);
    return { ok: true };
  });

  const sendFile = async (ticketId: string, fileId: string, reply: import('fastify').FastifyReply) => {
    const f = (await q.query('SELECT * FROM ticket_files WHERE id = $1 AND ticket_id = $2', [fileId, ticketId])).rows[0];
    if (!f) throw new HttpError(404, 'not_found', 'File not found.');
    const full = path.join(dir, f.path);
    if (!fs.existsSync(full)) throw new HttpError(404, 'not_found', 'File not found.');
    reply.type(f.mime).header('Content-Disposition', `${f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${f.name.replace(/"/g, '')}"`);
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'").header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.readFileSync(full));
  };
  app.get('/api/support/t/:key/files/:fid', async (req, reply) => {
    const p = req.params as { key: string; fid: string };
    const t = await load('t.public_key', z.string().min(10).max(60).parse(p.key));
    return sendFile(t.id, z.string().uuid().parse(p.fid), reply);
  });

  /** Tickets of the signed-in person (by account or email). */
  app.get('/api/support/mine', async (req) => {
    const me = await who(req);
    if (!me) throw new HttpError(401, 'unauthorized', 'Sign in to see your tickets.');
    const rows = (
      await q.query(
        `SELECT t.*, o.name AS org_name, e.name AS event_name FROM tickets t LEFT JOIN orgs o ON o.id = t.org_id LEFT JOIN tournaments e ON e.id = t.tournament_id
          WHERE t.user_id = $1 OR lower(t.requester_email) = lower($2) ORDER BY t.updated_at DESC LIMIT 200`,
        [me.id, me.email],
      )
    ).rows;
    return { tickets: rows.map((t) => ({ ...dto(t, false), key: t.public_key })) };
  });

  // ---------------------------------------------------------------- the team (Admin > Support)
  app.get('/api/admin/tickets', { preHandler: admin }, async (req) => {
    const f = z
      .object({
        status: z.enum([...STATUSES, 'active']).default('active'),
        priority: z.enum(PRIORITIES).optional(),
        category: z.enum(CATEGORIES).optional(),
        assigned: z.enum(['me', 'none', 'any']).default('any'),
        q: z.string().trim().max(100).optional(),
      })
      .parse(req.query);
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.status === 'active') w.push("t.status IN ('open', 'pending')");
    else (v.push(f.status), w.push(`t.status = $${v.length}`));
    if (f.priority) (v.push(f.priority), w.push(`t.priority = $${v.length}`));
    if (f.category) (v.push(f.category), w.push(`t.category = $${v.length}`));
    if (f.assigned === 'me') (v.push(userOf(req).id), w.push(`t.assigned_to = $${v.length}`));
    if (f.assigned === 'none') w.push('t.assigned_to IS NULL');
    if (f.q) (v.push(`%${f.q}%`), w.push(`(t.subject ILIKE $${v.length} OR t.requester_email ILIKE $${v.length} OR t.requester_name ILIKE $${v.length} OR t.number::text = replace($${v.length}, '%', ''))`));
    const rows = (
      await q.query(
        `SELECT t.*, o.name AS org_name, e.name AS event_name, a.name AS assignee_name, a.email AS assignee_email
           FROM tickets t LEFT JOIN orgs o ON o.id = t.org_id LEFT JOIN tournaments e ON e.id = t.tournament_id LEFT JOIN users a ON a.id = t.assigned_to
          WHERE ${w.join(' AND ')}
          ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 500`,
        v,
      )
    ).rows;
    const counts = (await q.query<Record<string, string>>("SELECT count(*) FILTER (WHERE status = 'open')::text AS open, count(*) FILTER (WHERE status = 'pending')::text AS pending, count(*) FILTER (WHERE status IN ('open', 'pending') AND priority = 'urgent')::text AS urgent, count(*) FILTER (WHERE status IN ('open', 'pending') AND assigned_to IS NULL)::text AS unassigned FROM tickets")).rows[0];
    return { tickets: rows.map((t) => dto(t, true)), counts: Object.fromEntries(Object.entries(counts).map(([k, x]) => [k, Number(x)])) };
  });

  app.get('/api/admin/tickets/:id', { preHandler: admin }, async (req) => {
    const t = await load('t.id', z.string().uuid().parse((req.params as { id: string }).id));
    const history = (await q.query('SELECT number, subject, status, created_at FROM tickets WHERE lower(requester_email) = lower($1) AND id <> $2 ORDER BY created_at DESC LIMIT 10', [t.requester_email, t.id])).rows;
    return {
      ticket: dto(t, true),
      messages: await thread(t.id, true),
      admins: (await q.query('SELECT id, name, email FROM users WHERE is_platform_admin AND NOT disabled ORDER BY name')).rows,
      otherTickets: history.map((h) => ({ number: h.number, subject: h.subject, status: h.status, at: new Date(h.created_at).toISOString() })),
    };
  });

  app.post('/api/admin/tickets/:id/messages', { preHandler: admin, ...big }, async (req) => {
    const t = await load('t.id', z.string().uuid().parse((req.params as { id: string }).id));
    const b = z.object({ body: z.string().trim().min(1).max(10_000), internal: z.boolean().default(false), files, status: z.enum(STATUSES).optional() }).parse(req.body);
    const me = userOf(req);
    const m = (await q.query("INSERT INTO ticket_messages (ticket_id, author_kind, author_user_id, author_name, body, internal) VALUES ($1, 'team', $2, $3, $4, $5) RETURNING id", [t.id, me.id, me.name, b.body, b.internal])).rows[0];
    await saveFiles(t.id, Number(m.id), b.files);
    if (!b.internal) {
      const status = b.status ?? 'pending';
      await q.query("UPDATE tickets SET status = $2, last_reply_by = 'team', assigned_to = COALESCE(assigned_to, $3), updated_at = now() WHERE id = $1", [t.id, status, me.id]);
      void mailer.send({
        to: t.requester_email,
        kind: 'ticket',
        subject: `[#${t.number}] ${status === 'resolved' ? 'Resolved: ' : 'Reply: '}${t.subject}`,
        body: [`Hi ${t.requester_name.split(' ')[0]},`, ...b.body.split(/\n{2,}/).slice(0, 20), status === 'resolved' ? 'We have marked this as resolved. Reply with the link below if you still need help.' : 'Reply with the link below.'],
        button: { text: 'View and reply', url: link(t) },
      });
    } else await q.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
    return { ok: true };
  });

  app.patch('/api/admin/tickets/:id', { preHandler: admin }, async (req) => {
    const t = await load('t.id', z.string().uuid().parse((req.params as { id: string }).id));
    const b = z.object({ status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), category: z.enum(CATEGORIES).optional(), assignedTo: z.string().uuid().nullable().optional() }).parse(req.body);
    if (b.assignedTo) {
      const a = await repo.userById(b.assignedTo);
      if (!a || !a.is_platform_admin) throw new HttpError(400, 'not_admin', 'Tickets can be assigned to Go Live admins only.');
    }
    await q.query(
      `UPDATE tickets SET status = COALESCE($2, status), priority = COALESCE($3, priority), category = COALESCE($4, category),
              assigned_to = CASE WHEN $5::boolean THEN $6::uuid ELSE assigned_to END, updated_at = now() WHERE id = $1`,
      [t.id, b.status ?? null, b.priority ?? null, b.category ?? null, b.assignedTo !== undefined, b.assignedTo ?? null],
    );
    const me = userOf(req);
    const changes = [b.status && `status ${t.status} → ${b.status}`, b.priority && `priority ${t.priority} → ${b.priority}`, b.category && `category → ${b.category}`, b.assignedTo !== undefined && `assigned to ${b.assignedTo ? ((await repo.userById(b.assignedTo))?.name ?? '') : 'nobody'}`].filter(Boolean);
    if (changes.length) await q.query("INSERT INTO ticket_messages (ticket_id, author_kind, author_user_id, author_name, body, internal) VALUES ($1, 'system', $2, $3, $4, true)", [t.id, me.id, me.name, `${me.name}: ${changes.join(', ')}`]);
    if ((b.status === 'resolved' || b.status === 'closed') && b.status !== t.status) {
      void mailer.send({
        to: t.requester_email,
        kind: 'ticket',
        subject: `[#${t.number}] ${b.status === 'closed' ? 'Closed' : 'Resolved'}: ${t.subject}`,
        body: [`Hi ${t.requester_name.split(' ')[0]},`, b.status === 'closed' ? 'We have closed this ticket. Raise a new one any time.' : 'We have marked this as resolved. Reply with the link if you still need help.'],
        button: { text: 'View your ticket', url: link(t) },
      });
    }
    if (b.assignedTo && b.assignedTo !== me.id) {
      const a = (await repo.userById(b.assignedTo))!;
      void mailer.send({ to: a.email, kind: 'ticket', subject: `Ticket #${t.number} assigned to you: ${t.subject}`, body: [`${me.name} assigned this ticket to you.`], button: { text: 'Open the ticket', url: `${base()}/web/admin/support/${t.id}` } });
    }
    return { ok: true };
  });

  app.get('/api/admin/tickets/:id/files/:fid', { preHandler: admin }, async (req, reply) => {
    const p = req.params as { id: string; fid: string };
    return sendFile(z.string().uuid().parse(p.id), z.string().uuid().parse(p.fid), reply);
  });
}
